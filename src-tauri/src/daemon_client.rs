//! The app side of the terminal daemon.
//!
//! Connects to a running daemon, starting one if there is none, and turns the
//! socket back into the same calls `PtyManager` offered when it lived in this
//! process. Output arriving over the socket is recorded here and handed to the
//! frontend, so recordings and terminal-exit events behave exactly as before.
//!
//! Every entry point returns a `Result`, and the caller falls back to an
//! in-process `PtyManager` on failure — a broken daemon should degrade to the
//! old behaviour, not to no terminals at all.

use crate::daemon::{self, Endpoint, Envelope, Message, Request};
use crate::errors::PtyError;
use crate::pty_manager::{TerminalDebugInfo, TerminalExitPayload, TerminalOutput};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{ipc::Channel, AppHandle, Emitter, Manager};

/// How long to wait for a freshly spawned daemon to publish its endpoint.
const SPAWN_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

type Pending = Arc<Mutex<HashMap<u64, Sender<Result<serde_json::Value, String>>>>>;
type Sinks = Arc<Mutex<HashMap<String, Channel<TerminalOutput>>>>;

pub struct DaemonClient {
    writer: Mutex<TcpStream>,
    app_handle: Mutex<Option<AppHandle>>,
    next_id: AtomicU64,
    pending: Pending,
    sinks: Sinks,
}

impl DaemonClient {
    /// Attach to the daemon, starting it if necessary.
    pub fn connect(app_handle: &AppHandle) -> Result<Arc<DaemonClient>, PtyError> {
        let endpoint = match daemon::read_endpoint().and_then(|endpoint| {
            connect_to(&endpoint).map(|stream| (endpoint, stream))
        }) {
            Some(found) => Some(found),
            None => {
                spawn_daemon()?;
                wait_for_daemon()
            }
        };

        let (endpoint, stream) =
            endpoint.ok_or_else(|| PtyError::from("daemon did not become reachable".to_string()))?;

        let writer = stream
            .try_clone()
            .map_err(|err| PtyError::from(err.to_string()))?;
        let client = Arc::new(DaemonClient {
            writer: Mutex::new(writer),
            app_handle: Mutex::new(Some(app_handle.clone())),
            next_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            sinks: Arc::new(Mutex::new(HashMap::new())),
        });

        client.spawn_reader(stream, app_handle.clone());
        client.request(Request::Hello {
            token: endpoint.token.clone(),
        })?;

        let _ = crate::debug_log::append_debug_log(&format!(
            "[backend:daemon_client] attached to daemon pid={} port={}",
            endpoint.pid, endpoint.port
        ));
        Ok(client)
    }

    /// Reads the socket forever: completes pending requests, and forwards
    /// output and exits exactly where the in-process manager used to.
    fn spawn_reader(self: &Arc<Self>, stream: TcpStream, app_handle: AppHandle) {
        let pending = self.pending.clone();
        let sinks = self.sinks.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stream);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let Ok(message) = serde_json::from_str::<Message>(&line) else {
                    continue;
                };
                match message {
                    Message::Ok { id, value } => {
                        if let Some(tx) = pending.lock().unwrap().remove(&id) {
                            let _ = tx.send(Ok(value));
                        }
                    }
                    Message::Err { id, message } => {
                        if let Some(tx) = pending.lock().unwrap().remove(&id) {
                            let _ = tx.send(Err(message));
                        }
                    }
                    Message::Output { terminal_id, data } => {
                        // The daemon does not record; this is the one place
                        // every byte passes through on the app side.
                        app_handle
                            .state::<crate::session_recorder::SessionRecorder>()
                            .record_transport_output(&terminal_id, &data);
                        let sink = sinks.lock().unwrap().get(&terminal_id).cloned();
                        if let Some(channel) = sink {
                            if channel
                                .send(TerminalOutput {
                                    terminal_id: terminal_id.clone(),
                                    data,
                                })
                                .is_err()
                            {
                                sinks.lock().unwrap().remove(&terminal_id);
                            }
                        }
                    }
                    Message::Exit {
                        terminal_id,
                        exit_code,
                    } => {
                        sinks.lock().unwrap().remove(&terminal_id);
                        let _ = app_handle.emit(
                            "terminal-exit",
                            TerminalExitPayload {
                                terminal_id,
                                exit_code,
                            },
                        );
                    }
                }
            }

            let _ = crate::debug_log::append_debug_log(
                "[backend:daemon_client] daemon connection closed",
            );
        });
    }

    fn request(&self, request: Request) -> Result<serde_json::Value, PtyError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = channel();
        self.pending.lock().unwrap().insert(id, tx);

        let mut line = serde_json::to_string(&Envelope { id, request })
            .map_err(|err| PtyError::from(err.to_string()))?;
        line.push('\n');
        {
            let mut writer = self.writer.lock().unwrap();
            writer
                .write_all(line.as_bytes())
                .and_then(|_| writer.flush())
                .map_err(|err| PtyError::from(err.to_string()))?;
        }

        match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(message)) => Err(PtyError::from(message)),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(PtyError::from("daemon did not answer".to_string()))
            }
        }
    }

    pub fn create_terminal(
        &self,
        terminal_id: String,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        on_output: Channel<TerminalOutput>,
    ) -> Result<(), PtyError> {
        // Register before asking, so replayed output from a reattach is not
        // dropped for want of somewhere to put it.
        self.sinks
            .lock()
            .unwrap()
            .insert(terminal_id.clone(), on_output);
        let result = self.request(Request::CreateTerminal {
            terminal_id: terminal_id.clone(),
            cwd,
            cols,
            rows,
        });
        if result.is_err() {
            self.sinks.lock().unwrap().remove(&terminal_id);
        }
        result.map(|_| ())
    }

    pub fn write_terminal(&self, terminal_id: &str, data: &str) -> Result<(), PtyError> {
        // Recorded here rather than in the daemon, which has no recorder. Both
        // directions have to land in the same cast or a recording shows only
        // half the conversation — output with no sign of what asked for it.
        if let Some(app_handle) = self.app_handle.lock().unwrap().as_ref() {
            app_handle
                .state::<crate::session_recorder::SessionRecorder>()
                .record_transport_input(terminal_id, data);
        }
        self.request(Request::WriteTerminal {
            terminal_id: terminal_id.to_owned(),
            data: data.to_owned(),
        })
        .map(|_| ())
    }

    pub fn resize_terminal(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<(), PtyError> {
        if let Some(app_handle) = self.app_handle.lock().unwrap().as_ref() {
            app_handle
                .state::<crate::session_recorder::SessionRecorder>()
                .record_event(
                    "resize",
                    serde_json::json!({ "terminalId": terminal_id, "cols": cols, "rows": rows }),
                );
        }
        self.request(Request::ResizeTerminal {
            terminal_id: terminal_id.to_owned(),
            cols,
            rows,
        })
        .map(|_| ())
    }

    pub fn close_terminal(&self, terminal_id: &str) -> Result<(), PtyError> {
        self.sinks.lock().unwrap().remove(terminal_id);
        self.request(Request::CloseTerminal {
            terminal_id: terminal_id.to_owned(),
        })
        .map(|_| ())
    }

    pub fn warm_pool(&self, count: usize) -> Result<(), PtyError> {
        self.request(Request::WarmPool { count }).map(|_| ())
    }

    pub fn refresh_pool(&self) -> Result<(), PtyError> {
        self.request(Request::RefreshPool).map(|_| ())
    }

    pub fn live_terminal_ids(&self) -> Result<Vec<String>, PtyError> {
        let value = self.request(Request::ListLiveTerminals)?;
        serde_json::from_value(value).map_err(|err| PtyError::from(err.to_string()))
    }

    pub fn get_terminal_cwd(&self, terminal_id: &str) -> Result<Option<String>, PtyError> {
        let value = self.request(Request::GetTerminalCwd {
            terminal_id: terminal_id.to_owned(),
        })?;
        serde_json::from_value(value).map_err(|err| PtyError::from(err.to_string()))
    }

    pub fn get_terminal_debug_info(
        &self,
        terminal_id: &str,
    ) -> Result<TerminalDebugInfo, PtyError> {
        let value = self.request(Request::GetTerminalDebugInfo {
            terminal_id: terminal_id.to_owned(),
        })?;
        serde_json::from_value(value).map_err(|err| PtyError::from(err.to_string()))
    }
}

fn connect_to(endpoint: &Endpoint) -> Option<TcpStream> {
    TcpStream::connect_timeout(
        &SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, endpoint.port)),
        Duration::from_millis(500),
    )
    .ok()
}

fn spawn_daemon() -> Result<(), PtyError> {
    let exe = std::env::current_exe().map_err(|err| PtyError::from(err.to_string()))?;
    let mut command = std::process::Command::new(exe);
    command
        .arg(daemon::DAEMON_ARG)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    #[cfg(unix)]
    {
        // Its own session, so quitting the app — or the terminal that launched
        // it — does not take the daemon down with it.
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    command
        .spawn()
        .map(|_| ())
        .map_err(|err| PtyError::from(err.to_string()))
}

fn wait_for_daemon() -> Option<(Endpoint, TcpStream)> {
    let deadline = std::time::Instant::now() + SPAWN_TIMEOUT;
    while std::time::Instant::now() < deadline {
        if let Some(endpoint) = daemon::read_endpoint() {
            if let Some(stream) = connect_to(&endpoint) {
                return Some((endpoint, stream));
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    None
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

/// Where this process's terminals actually live.
///
/// The daemon is preferred, because terminals there survive the app being
/// restarted. If it cannot be reached we keep the old in-process behaviour
/// rather than leaving the user with no terminals at all.
pub enum TerminalBackend {
    Daemon(Arc<DaemonClient>),
    InProcess,
}

impl TerminalBackend {
    pub fn connect(app_handle: &AppHandle) -> TerminalBackend {
        if std::env::var("DISPATCHER_DAEMON").map(|v| v == "0").unwrap_or(false) {
            let _ = crate::debug_log::append_debug_log(
                "[backend:daemon_client] DISPATCHER_DAEMON=0, terminals stay in-process",
            );
            return TerminalBackend::InProcess;
        }

        match DaemonClient::connect(app_handle) {
            Ok(client) => TerminalBackend::Daemon(client),
            Err(err) => {
                let _ = crate::debug_log::append_debug_log(&format!(
                    "[backend:daemon_client] no daemon ({}), terminals stay in-process",
                    err.message
                ));
                TerminalBackend::InProcess
            }
        }
    }

    pub fn is_daemon(&self) -> bool {
        matches!(self, TerminalBackend::Daemon(_))
    }
}
