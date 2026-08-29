//! A terminal daemon that outlives the desktop app.
//!
//! PTYs used to live inside the Tauri process, so quitting Dispatcher — or
//! `tauri dev` rebuilding it — killed every shell, every ssh connection and
//! every tmux client with it. This runs the same `PtyManager` in a separate
//! process that the app attaches to, so a restart reattaches to running
//! terminals and replays what it missed instead of rebuilding them.
//!
//! The transport is a loopback TCP socket rather than a unix socket so the
//! same code works on Windows. Anyone who can open a loopback port can reach
//! it, so a connection is only served after presenting the token from the
//! endpoint file, which is written owner-readable.

use crate::errors::PtyError;
use crate::pty_manager::{NullPtyHost, OutputSink, PtyHost, PtyManager};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

/// Argv flag that turns this binary into the daemon instead of the app.
pub const DAEMON_ARG: &str = "--dispatcher-daemon";

/// How long the daemon lingers with no terminals and nobody attached. Long
/// enough to survive an app restart, short enough not to leak processes.
const IDLE_SHUTDOWN: Duration = Duration::from_secs(15 * 60);

/// Written by the daemon, read by the app to find it.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

pub fn endpoint_path() -> PathBuf {
    let name = if cfg!(debug_assertions) {
        "daemon.dev.json"
    } else {
        "daemon.json"
    };
    crate::debug_log::debug_log_path()
        .parent()
        .map(|parent| parent.join(name))
        .unwrap_or_else(|| std::env::temp_dir().join(name))
}

pub fn read_endpoint() -> Option<Endpoint> {
    let raw = std::fs::read_to_string(endpoint_path()).ok()?;
    serde_json::from_str(&raw).ok()
}

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Request {
    #[serde(rename_all = "camelCase")]
    Hello { token: String },
    #[serde(rename_all = "camelCase")]
    CreateTerminal {
        terminal_id: String,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
    },
    #[serde(rename_all = "camelCase")]
    WriteTerminal { terminal_id: String, data: String },
    #[serde(rename_all = "camelCase")]
    ResizeTerminal {
        terminal_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename_all = "camelCase")]
    CloseTerminal { terminal_id: String },
    #[serde(rename_all = "camelCase")]
    WarmPool { count: usize },
    RefreshPool,
    ListLiveTerminals,
    #[serde(rename_all = "camelCase")]
    GetTerminalCwd { terminal_id: String },
    #[serde(rename_all = "camelCase")]
    GetTerminalDebugInfo { terminal_id: String },
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub id: u64,
    #[serde(flatten)]
    pub request: Request,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Message {
    #[serde(rename_all = "camelCase")]
    Ok { id: u64, value: serde_json::Value },
    #[serde(rename_all = "camelCase")]
    Err { id: u64, message: String },
    #[serde(rename_all = "camelCase")]
    Output { terminal_id: String, data: String },
    #[serde(rename_all = "camelCase")]
    Exit {
        terminal_id: String,
        exit_code: Option<i32>,
    },
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/// One attached app.
struct Client {
    id: u64,
    writer: Mutex<TcpStream>,
}

impl Client {
    fn send(&self, message: &Message) -> bool {
        let Ok(mut line) = serde_json::to_string(message) else {
            return false;
        };
        line.push('\n');
        let mut writer = self.writer.lock().unwrap();
        writer.write_all(line.as_bytes()).is_ok() && writer.flush().is_ok()
    }
}

type Clients = Arc<Mutex<Vec<Arc<Client>>>>;

/// Routes one terminal's output to the app that asked for it. Held by the
/// router as a `Weak`, so a disconnected app does not keep the socket alive —
/// the PTY keeps running and the next attach replays what was missed.
struct ClientSink {
    client: Weak<Client>,
}

impl OutputSink for ClientSink {
    fn send(&self, terminal_id: &str, data: &str) -> bool {
        let Some(client) = self.client.upgrade() else {
            return false;
        };
        client.send(&Message::Output {
            terminal_id: terminal_id.to_owned(),
            data: data.to_owned(),
        })
    }
}

/// The daemon does not record: the app receives every byte over the socket and
/// records it there, so recordings keep landing next to the app's other logs.
struct DaemonHost {
    clients: Clients,
}

impl PtyHost for DaemonHost {
    fn record_output(&self, _terminal_id: &str, _data: &str) {}
    fn record_input(&self, _terminal_id: &str, _data: &str) {}
    fn record_event(&self, _name: &str, _payload: serde_json::Value) {}

    fn terminal_exited(&self, terminal_id: &str, exit_code: Option<i32>) {
        let message = Message::Exit {
            terminal_id: terminal_id.to_owned(),
            exit_code,
        };
        for client in self.clients.lock().unwrap().iter() {
            client.send(&message);
        }
    }
}

fn write_endpoint(endpoint: &Endpoint) -> std::io::Result<()> {
    let path = endpoint_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_string(endpoint).unwrap_or_default())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // The token is the only thing standing between a local process and a
        // shell, so do not let anyone else read it.
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Run as the daemon. Never returns under normal operation.
pub fn run_daemon() -> std::io::Result<()> {
    let _ = crate::debug_log::init_debug_log();

    let listener = TcpListener::bind(SocketAddr::V4(SocketAddrV4::new(
        Ipv4Addr::LOCALHOST,
        0,
    )))?;
    let port = listener.local_addr()?.port();
    let token = uuid::Uuid::new_v4().to_string();
    write_endpoint(&Endpoint {
        port,
        token: token.clone(),
        pid: std::process::id(),
    })?;

    let clients: Clients = Arc::new(Mutex::new(Vec::new()));
    let manager = Arc::new(PtyManager::new());
    manager.set_host(Arc::new(DaemonHost {
        clients: clients.clone(),
    }));

    let _ = crate::debug_log::append_debug_log(&format!(
        "[daemon] listening port={} pid={}",
        port,
        std::process::id()
    ));

    spawn_idle_watchdog(manager.clone(), clients.clone());

    let next_client_id = AtomicU64::new(1);
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let id = next_client_id.fetch_add(1, Ordering::Relaxed);
        let manager = manager.clone();
        let clients = clients.clone();
        let token = token.clone();
        std::thread::spawn(move || {
            serve_client(id, stream, manager, clients, token);
        });
    }

    Ok(())
}

/// Exit once there is nothing left to hold on to. Terminals are the point of
/// the daemon, so it only leaves when there are none and nobody is attached.
fn spawn_idle_watchdog(manager: Arc<PtyManager>, clients: Clients) {
    std::thread::spawn(move || {
        let mut empty_since: Option<Instant> = None;
        loop {
            std::thread::sleep(Duration::from_secs(30));
            let idle = manager.live_terminal_ids().is_empty()
                && clients.lock().unwrap().is_empty();
            if !idle {
                empty_since = None;
                continue;
            }
            match empty_since {
                Some(since) if since.elapsed() >= IDLE_SHUTDOWN => {
                    let _ = crate::debug_log::append_debug_log("[daemon] idle with no terminals, exiting");
                    let _ = std::fs::remove_file(endpoint_path());
                    std::process::exit(0);
                }
                Some(_) => {}
                None => empty_since = Some(Instant::now()),
            }
        }
    });
}

fn serve_client(
    id: u64,
    stream: TcpStream,
    manager: Arc<PtyManager>,
    clients: Clients,
    token: String,
) {
    let Ok(write_half) = stream.try_clone() else {
        return;
    };
    let client = Arc::new(Client {
        id,
        writer: Mutex::new(write_half),
    });

    let mut authenticated = false;
    let reader = BufReader::new(stream);

    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let envelope: Envelope = match serde_json::from_str(&line) {
            Ok(envelope) => envelope,
            Err(err) => {
                let _ = crate::debug_log::append_debug_log(&format!("[daemon] bad request: {}", err));
                continue;
            }
        };

        if !authenticated {
            match &envelope.request {
                Request::Hello { token: offered } if *offered == token => {
                    authenticated = true;
                    clients.lock().unwrap().push(client.clone());
                    let _ = crate::debug_log::append_debug_log(&format!("[daemon] client {} attached", id));
                    client.send(&Message::Ok {
                        id: envelope.id,
                        value: serde_json::json!({ "pid": std::process::id() }),
                    });
                }
                _ => {
                    client.send(&Message::Err {
                        id: envelope.id,
                        message: "unauthenticated".to_string(),
                    });
                    break;
                }
            }
            continue;
        }

        let response = dispatch(&manager, &client, envelope.request);
        let message = match response {
            Ok(value) => Message::Ok {
                id: envelope.id,
                value,
            },
            Err(err) => Message::Err {
                id: envelope.id,
                message: err.message,
            },
        };
        if !client.send(&message) {
            break;
        }
    }

    clients.lock().unwrap().retain(|entry| entry.id != id);
    let _ = crate::debug_log::append_debug_log(&format!("[daemon] client {} detached", id));
}

fn dispatch(
    manager: &Arc<PtyManager>,
    client: &Arc<Client>,
    request: Request,
) -> Result<serde_json::Value, PtyError> {
    match request {
        Request::Hello { .. } => Ok(serde_json::Value::Null),
        Request::CreateTerminal {
            terminal_id,
            cwd,
            cols,
            rows,
        } => {
            let sink = Box::new(ClientSink {
                client: Arc::downgrade(client),
            });
            manager.create_terminal(terminal_id, cwd, cols, rows, sink)?;
            Ok(serde_json::Value::Null)
        }
        Request::WriteTerminal { terminal_id, data } => {
            manager.write_terminal(&terminal_id, data.as_bytes())?;
            Ok(serde_json::Value::Null)
        }
        Request::ResizeTerminal {
            terminal_id,
            cols,
            rows,
        } => {
            manager.resize_terminal(&terminal_id, cols, rows)?;
            Ok(serde_json::Value::Null)
        }
        Request::CloseTerminal { terminal_id } => {
            manager.close_terminal(&terminal_id)?;
            Ok(serde_json::Value::Null)
        }
        Request::WarmPool { count } => {
            manager.warm_pool(count)?;
            Ok(serde_json::Value::Null)
        }
        Request::RefreshPool => {
            manager.refresh_pool()?;
            Ok(serde_json::Value::Null)
        }
        Request::ListLiveTerminals => Ok(serde_json::json!(manager.live_terminal_ids())),
        Request::GetTerminalCwd { terminal_id } => {
            Ok(serde_json::json!(manager.get_terminal_cwd(&terminal_id)?))
        }
        Request::GetTerminalDebugInfo { terminal_id } => Ok(serde_json::to_value(
            manager.get_terminal_debug_info(&terminal_id)?,
        )
        .unwrap_or(serde_json::Value::Null)),
    }
}

/// Used by the daemon process itself when it has no host of its own yet.
pub fn null_host() -> Arc<dyn PtyHost> {
    Arc::new(NullPtyHost)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_round_trip_with_their_id() {
        let line = serde_json::to_string(&Envelope {
            id: 7,
            request: Request::WriteTerminal {
                terminal_id: "t1".into(),
                data: "echo hi\n".into(),
            },
        })
        .unwrap();
        // The id sits alongside the tagged request, so one line carries both.
        assert!(line.contains("\"id\":7"));
        assert!(line.contains("\"type\":\"writeTerminal\""));

        let back: Envelope = serde_json::from_str(&line).unwrap();
        assert_eq!(back.id, 7);
        match back.request {
            Request::WriteTerminal { terminal_id, data } => {
                assert_eq!(terminal_id, "t1");
                assert_eq!(data, "echo hi\n");
            }
            other => panic!("wrong request: {:?}", other),
        }
    }

    #[test]
    fn output_survives_bytes_that_are_not_text() {
        // PTY output is arbitrary; escape sequences and newlines must come back
        // byte for byte or the terminal renders nonsense.
        let data = "\u{1b}[31mred\u{1b}[0m\r\n\ttab \" quote \\ slash";
        let line = serde_json::to_string(&Message::Output {
            terminal_id: "t1".into(),
            data: data.into(),
        })
        .unwrap();
        assert!(!line.contains('\n'), "a message must stay on one line");

        match serde_json::from_str::<Message>(&line).unwrap() {
            Message::Output { data: back, .. } => assert_eq!(back, data),
            other => panic!("wrong message: {:?}", other),
        }
    }

    #[test]
    fn dev_and_release_daemons_do_not_share_an_endpoint() {
        // A dev build must not attach to the installed app's daemon, or a
        // rebuild would hand its terminals to the wrong process.
        let name = endpoint_path()
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if cfg!(debug_assertions) {
            assert_eq!(name, "daemon.dev.json");
        } else {
            assert_eq!(name, "daemon.json");
        }
    }
}
