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
//!
//! The daemon outlives the app, which is the point of it, but it also means a
//! daemon that has stopped answering survives every relaunch. So the app does
//! not take one on trust: it is probed before it is used. While it is used,
//! nothing on the main thread waits for it -- writes and resizes are sent and
//! not waited on -- and an unanswered request trips a breaker: later calls fail
//! at once instead of each waiting out a timeout, and a background check
//! either sees the daemon recover or, once it has been unresponsive for long
//! enough, replaces it.

use crate::daemon::{self, Endpoint, Envelope, Message, Request};
use crate::errors::PtyError;
use crate::pty_manager::{TerminalDebugInfo, TerminalExitPayload, TerminalOutput};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, AppHandle, Emitter, Manager};

/// How long to wait for a freshly spawned daemon to publish its endpoint.
const SPAWN_TIMEOUT: Duration = Duration::from_secs(10);
/// For requests that are waited on: starting a shell, listing terminals. Only
/// ever waited on off the main thread. Generous, because the daemon answers one
/// connection's requests in turn, and on launch dozens of terminals reattach at
/// once, each replaying what it missed.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// The health check: listing terminals takes the lock every terminal operation
/// needs, so it goes unanswered when the daemon is wedged even though its
/// socket is perfectly fine. Asked on a connection of its own, so it is never
/// queued behind this app's own requests.
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const PROBE_INTERVAL: Duration = Duration::from_secs(2);
/// How long the daemon may go unresponsive before it is replaced. Replacing it
/// ends the shells it holds, so this is not done at the first hiccup.
const REPLACE_AFTER: Duration = Duration::from_secs(30);
/// A send to the daemon that blocks this long means it has stopped reading.
const SOCKET_WRITE_TIMEOUT: Duration = Duration::from_secs(2);

type Pending = Arc<Mutex<HashMap<u64, Sender<Result<serde_json::Value, String>>>>>;
type Sinks = Arc<Mutex<HashMap<String, Channel<TerminalOutput>>>>;

/// One socket to one daemon process.
struct Connection {
    endpoint: Endpoint,
    writer: Mutex<TcpStream>,
    pending: Pending,
    next_id: AtomicU64,
    /// The socket failed or closed; nothing more will be answered on it.
    closed: AtomicBool,
    /// When a request first went unanswered. Cleared once a probe gets an
    /// answer; while set, ordinary requests fail without waiting.
    stalled_since: Mutex<Option<Instant>>,
    /// Told when the socket closes, so a daemon that died is noticed even when
    /// nothing is being asked of it.
    owner: OnceLock<Weak<DaemonClient>>,
}

impl Connection {
    fn open(
        endpoint: Endpoint,
        stream: TcpStream,
        sinks: Sinks,
        app_handle: Option<AppHandle>,
    ) -> Result<Arc<Connection>, PtyError> {
        let _ = stream.set_write_timeout(Some(SOCKET_WRITE_TIMEOUT));
        let writer = stream
            .try_clone()
            .map_err(|err| PtyError::from(err.to_string()))?;
        let connection = Arc::new(Connection {
            endpoint,
            writer: Mutex::new(writer),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            stalled_since: Mutex::new(None),
            owner: OnceLock::new(),
        });
        spawn_reader(Arc::clone(&connection), stream, sinks, app_handle);
        Ok(connection)
    }

    fn is_stalled(&self) -> bool {
        self.stalled_since.lock().unwrap().is_some()
    }

    fn stalled_for(&self) -> Option<Duration> {
        self.stalled_since.lock().unwrap().map(|since| since.elapsed())
    }

    fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = self.writer.lock().unwrap().shutdown(std::net::Shutdown::Both);
        // Fail whatever is still waiting now rather than at its timeout.
        self.pending.lock().unwrap().clear();
    }

    /// Ask and wait. Does not consult the breaker: the health check has to be
    /// able to get through while it is open.
    fn request(&self, request: Request, timeout: Duration) -> Result<serde_json::Value, PtyError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(PtyError::from("terminal daemon connection is closed".to_string()));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = channel();
        self.pending.lock().unwrap().insert(id, tx);

        let mut line = serde_json::to_string(&Envelope { id, request })
            .map_err(|err| PtyError::from(err.to_string()))?;
        line.push('\n');
        let sent = {
            let mut writer = self.writer.lock().unwrap();
            writer.write_all(line.as_bytes()).and_then(|_| writer.flush())
        };
        if let Err(err) = sent {
            // Possibly half a line on the wire; the connection is unusable.
            self.pending.lock().unwrap().remove(&id);
            self.close();
            return Err(PtyError::from(format!("terminal daemon stopped reading: {}", err)));
        }

        match rx.recv_timeout(timeout) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(message)) => Err(PtyError::from(message)),
            Err(RecvTimeoutError::Timeout) => {
                self.pending.lock().unwrap().remove(&id);
                self.stalled_since.lock().unwrap().get_or_insert_with(Instant::now);
                Err(PtyError::from("daemon did not answer".to_string()))
            }
            Err(RecvTimeoutError::Disconnected) => {
                Err(PtyError::from("terminal daemon connection is closed".to_string()))
            }
        }
    }

    /// Send without waiting for the answer.
    ///
    /// For writes and resizes, which come from the main thread and have to
    /// reach the daemon in the order they were made -- so they go out on this
    /// one socket, in order, and nothing waits. A refusal still comes back and
    /// is logged by the reader; a socket that cannot be written fails here.
    fn notify(&self, request: Request) -> Result<(), PtyError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(PtyError::from("terminal daemon connection is closed".to_string()));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut line = serde_json::to_string(&Envelope { id, request })
            .map_err(|err| PtyError::from(err.to_string()))?;
        line.push('\n');
        let sent = {
            let mut writer = self.writer.lock().unwrap();
            writer.write_all(line.as_bytes()).and_then(|_| writer.flush())
        };
        sent.map_err(|err| {
            self.close();
            PtyError::from(format!("terminal daemon stopped reading: {}", err))
        })
    }

    /// Hello, then a request that needs the daemon's terminal lock. A wedged
    /// daemon accepts connections and answers Hello -- that touches nothing
    /// shared -- so only the second shows whether it can do any work.
    fn handshake(&self) -> Result<(), PtyError> {
        let hello = self.request(
            Request::Hello {
                token: self.endpoint.token.clone(),
            },
            PROBE_TIMEOUT,
        )?;
        let version = hello.get("version").and_then(|value| value.as_str());
        if version != Some(env!("CARGO_PKG_VERSION")) {
            // Kept: replacing a working daemon would end its shells for no
            // reason. Logged, because it may be missing fixes this app has.
            let _ = crate::debug_log::append_debug_log(&format!(
                "[backend:daemon_client] daemon pid={} is from another build version={} app={}",
                self.endpoint.pid,
                version.unwrap_or("unknown, from before daemons reported one"),
                env!("CARGO_PKG_VERSION")
            ));
        }
        self.request(Request::ListLiveTerminals, PROBE_TIMEOUT)?;
        Ok(())
    }
}

/// Reads the socket for as long as it is open: completes pending requests, and
/// forwards output and exits exactly where the in-process manager used to.
fn spawn_reader(
    connection: Arc<Connection>,
    stream: TcpStream,
    sinks: Sinks,
    app_handle: Option<AppHandle>,
) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let Ok(message) = serde_json::from_str::<Message>(&line) else {
                continue;
            };
            match message {
                Message::Ok { id, value } => {
                    if let Some(tx) = connection.pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(Ok(value));
                    }
                }
                Message::Err { id, message } => {
                    if let Some(tx) = connection.pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(Err(message));
                    } else {
                        // A write or resize, which nobody waits on.
                        let _ = crate::debug_log::append_debug_log(&format!(
                            "[backend:daemon_client] daemon refused request id={}: {}",
                            id, message
                        ));
                    }
                }
                Message::Output { terminal_id, data } => {
                    // The daemon does not record; this is the one place
                    // every byte passes through on the app side.
                    if let Some(app_handle) = &app_handle {
                        app_handle
                            .state::<crate::session_recorder::SessionRecorder>()
                            .record_transport_output(&terminal_id, &data);
                    }
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
                    if let Some(app_handle) = &app_handle {
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
        }

        let _ = crate::debug_log::append_debug_log(&format!(
            "[backend:daemon_client] daemon connection closed pid={}",
            connection.endpoint.pid
        ));
        connection.close();
        if let Some(owner) = connection.owner.get().and_then(Weak::upgrade) {
            owner.start_health_check();
        }
    });
}

pub struct DaemonClient {
    app_handle: Option<AppHandle>,
    connection: Mutex<Arc<Connection>>,
    /// `REQUEST_TIMEOUT`, other than in tests.
    request_timeout: Duration,
    sinks: Sinks,
    /// A health check is running. One at a time.
    checking: AtomicBool,
    me: Weak<DaemonClient>,
}

impl DaemonClient {
    /// Attach to the daemon, starting it -- or replacing it -- if necessary.
    pub fn connect(app_handle: &AppHandle) -> Result<Arc<DaemonClient>, PtyError> {
        let sinks: Sinks = Arc::new(Mutex::new(HashMap::new()));
        let connection = establish(&sinks, Some(app_handle.clone()))?;
        Ok(DaemonClient::with_connection(
            Some(app_handle.clone()),
            sinks,
            connection,
            REQUEST_TIMEOUT,
        ))
    }

    fn with_connection(
        app_handle: Option<AppHandle>,
        sinks: Sinks,
        connection: Arc<Connection>,
        request_timeout: Duration,
    ) -> Arc<DaemonClient> {
        let client = Arc::new_cyclic(|me| DaemonClient {
            app_handle,
            connection: Mutex::new(Arc::clone(&connection)),
            request_timeout,
            sinks,
            checking: AtomicBool::new(false),
            me: me.clone(),
        });
        let _ = connection.owner.set(Arc::downgrade(&client));
        // The socket may already have closed before there was an owner to tell.
        if connection.closed.load(Ordering::Acquire) {
            client.start_health_check();
        }
        client
    }

    fn current(&self) -> Arc<Connection> {
        Arc::clone(&self.connection.lock().unwrap())
    }

    /// The connection to use, unless the breaker is open: a request that has
    /// not been answered is already being followed up in the background, and
    /// waiting out another timeout would only hold up whoever asked.
    fn usable(&self) -> Result<Arc<Connection>, PtyError> {
        let connection = self.current();
        if connection.is_stalled() {
            self.start_health_check();
            return Err(PtyError::from(
                "terminal daemon is not responding; checking on it in the background".to_string(),
            ));
        }
        Ok(connection)
    }

    fn request(&self, request: Request) -> Result<serde_json::Value, PtyError> {
        let connection = self.usable()?;
        let result = connection.request(request, self.request_timeout);
        if connection.is_stalled() || connection.closed.load(Ordering::Acquire) {
            self.start_health_check();
        }
        result
    }

    fn notify(&self, request: Request) -> Result<(), PtyError> {
        let connection = self.usable()?;
        let result = connection.notify(request);
        if connection.closed.load(Ordering::Acquire) {
            self.start_health_check();
        }
        result
    }

    /// Follow up on an unanswered request or a closed socket until the daemon
    /// is either answering again or has been replaced.
    fn start_health_check(&self) {
        if self.checking.swap(true, Ordering::AcqRel) {
            return;
        }
        let Some(client) = self.me.upgrade() else {
            self.checking.store(false, Ordering::Release);
            return;
        };
        std::thread::spawn(move || {
            client.health_check();
            client.checking.store(false, Ordering::Release);
        });
    }

    fn health_check(&self) {
        loop {
            std::thread::sleep(PROBE_INTERVAL);
            let connection = self.current();
            if connection.closed.load(Ordering::Acquire) {
                // The daemon died, or dropped this app for not reading. Either
                // way the terminals this window shows are gone from under it.
                if self.app_handle.is_none() {
                    return;
                }
                if self.replace_connection(&connection, "connection closed", false) {
                    return;
                }
                continue;
            }
            match probe(&connection.endpoint) {
                Ok(()) => {
                    let stalled_for = connection.stalled_for();
                    *connection.stalled_since.lock().unwrap() = None;
                    let _ = crate::debug_log::append_debug_log(&format!(
                        "[backend:daemon_client] daemon pid={} answering again after {:?}",
                        connection.endpoint.pid,
                        stalled_for.unwrap_or_default()
                    ));
                    return;
                }
                Err(err) => {
                    let stalled_for = connection.stalled_for().unwrap_or_default();
                    let _ = crate::debug_log::append_debug_log(&format!(
                        "[backend:daemon_client] daemon pid={} still not answering after {:?}: {}",
                        connection.endpoint.pid, stalled_for, err.message
                    ));
                    // Without an app there is no window to move onto a new
                    // daemon; that only happens in tests.
                    if stalled_for >= REPLACE_AFTER
                        && self.app_handle.is_some()
                        && self.replace_connection(&connection, "unresponsive", true)
                    {
                        return;
                    }
                }
            }
        }
    }

    /// Swap in a working daemon and reload the window onto it. Returns false
    /// when no daemon could be reached, to be tried again.
    fn replace_connection(&self, old: &Arc<Connection>, reason: &str, kill_old: bool) -> bool {
        let _ = crate::debug_log::append_debug_log(&format!(
            "[backend:daemon_client] replacing daemon connection pid={} reason={}",
            old.endpoint.pid, reason
        ));
        old.close();
        if kill_old {
            stop_daemon(&old.endpoint);
        }
        let connection = match establish(&self.sinks, self.app_handle.clone()) {
            Ok(connection) => connection,
            Err(err) => {
                let _ = crate::debug_log::append_debug_log(&format!(
                    "[backend:daemon_client] no daemon to replace it with: {}",
                    err.message
                ));
                return false;
            }
        };
        let _ = connection.owner.set(self.me.clone());
        // The page's output channels were registered with terminals that may
        // no longer exist; the reload registers fresh ones.
        self.sinks.lock().unwrap().clear();
        *self.connection.lock().unwrap() = connection;

        // Reloading the window is how every terminal gets asked for again: one
        // that survived is reattached, one that did not starts afresh, and a
        // tmux tab reconnects to its session.
        if let Some(window) = self
            .app_handle
            .as_ref()
            .and_then(|app_handle| app_handle.get_webview_window("main"))
        {
            let outcome = window.reload();
            let _ = crate::debug_log::append_debug_log(&format!(
                "[backend:daemon_client] reloaded the window onto the new daemon ok={}",
                outcome.is_ok()
            ));
        }
        true
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
        if let Some(app_handle) = self.app_handle.as_ref() {
            app_handle
                .state::<crate::session_recorder::SessionRecorder>()
                .record_transport_input(terminal_id, data);
        }
        self.notify(Request::WriteTerminal {
            terminal_id: terminal_id.to_owned(),
            data: data.to_owned(),
        })
    }

    pub fn resize_terminal(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<(), PtyError> {
        if let Some(app_handle) = self.app_handle.as_ref() {
            app_handle
                .state::<crate::session_recorder::SessionRecorder>()
                .record_event(
                    "resize",
                    serde_json::json!({ "terminalId": terminal_id, "cols": cols, "rows": rows }),
                );
        }
        self.notify(Request::ResizeTerminal {
            terminal_id: terminal_id.to_owned(),
            cols,
            rows,
        })
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

/// Whether the daemon can do work, asked over a connection of its own so the
/// answer is not queued behind this app's other requests.
fn probe(endpoint: &Endpoint) -> Result<(), PtyError> {
    let stream = connect_to(endpoint)
        .ok_or_else(|| PtyError::from("terminal daemon is not accepting connections".to_string()))?;
    let connection = Connection::open(
        endpoint.clone(),
        stream,
        Arc::new(Mutex::new(HashMap::new())),
        None,
    )?;
    let result = connection
        .request(
            Request::Hello {
                token: endpoint.token.clone(),
            },
            PROBE_TIMEOUT,
        )
        .and_then(|_| connection.request(Request::ListLiveTerminals, PROBE_TIMEOUT))
        .map(|_| ());
    connection.close();
    result
}

/// A connected, handshaken daemon: the one already running if it answers,
/// otherwise a fresh one.
///
/// A daemon that accepts the connection but does not answer is stopped first.
/// Otherwise every relaunch attached to the same wedged process -- it outlives
/// the app by design -- and froze the same way.
fn establish(sinks: &Sinks, app_handle: Option<AppHandle>) -> Result<Arc<Connection>, PtyError> {
    if let Some(endpoint) = daemon::read_endpoint() {
        if let Some(stream) = connect_to(&endpoint) {
            let connection =
                Connection::open(endpoint.clone(), stream, Arc::clone(sinks), app_handle.clone())?;
            match connection.handshake() {
                Ok(()) => {
                    log_attached(&endpoint);
                    return Ok(connection);
                }
                Err(err) => {
                    let _ = crate::debug_log::append_debug_log(&format!(
                        "[backend:daemon_client] daemon pid={} port={} is not answering ({}), replacing it",
                        endpoint.pid, endpoint.port, err.message
                    ));
                    connection.close();
                    stop_daemon(&endpoint);
                }
            }
        }
    }

    spawn_daemon()?;
    let (endpoint, stream) = wait_for_daemon()
        .ok_or_else(|| PtyError::from("daemon did not become reachable".to_string()))?;
    let connection = Connection::open(endpoint.clone(), stream, Arc::clone(sinks), app_handle)?;
    connection.handshake()?;
    log_attached(&endpoint);
    Ok(connection)
}

fn log_attached(endpoint: &Endpoint) {
    let _ = crate::debug_log::append_debug_log(&format!(
        "[backend:daemon_client] attached to daemon pid={} port={}",
        endpoint.pid, endpoint.port
    ));
}

/// End a daemon that has stopped answering, and forget its endpoint so the
/// next one is not mistaken for it.
///
/// Only once the pid is confirmed to still be a Dispatcher daemon: the endpoint
/// file can outlive its process, and the pid may since have been reused.
fn stop_daemon(endpoint: &Endpoint) {
    if daemon::read_endpoint().is_some_and(|current| current.pid == endpoint.pid) {
        let _ = std::fs::remove_file(daemon::endpoint_path());
    }

    #[cfg(unix)]
    {
        let pid = endpoint.pid as libc::pid_t;
        // 0 would signal this whole process group.
        if pid <= 0 || endpoint.pid == std::process::id() || !is_dispatcher_daemon(endpoint.pid) {
            let _ = crate::debug_log::append_debug_log(&format!(
                "[backend:daemon_client] pid={} is not a Dispatcher daemon, leaving it alone",
                endpoint.pid
            ));
            return;
        }
        // A wedged process still dies of SIGTERM -- it takes no cooperation --
        // but fall back to SIGKILL rather than trust that.
        unsafe { libc::kill(pid, libc::SIGTERM) };
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if unsafe { libc::kill(pid, 0) } != 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if unsafe { libc::kill(pid, 0) } == 0 {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        let _ = crate::debug_log::append_debug_log(&format!(
            "[backend:daemon_client] stopped daemon pid={}",
            endpoint.pid
        ));
    }
}

#[cfg(unix)]
fn is_dispatcher_daemon(pid: u32) -> bool {
    std::process::Command::new("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .is_some_and(|output| String::from_utf8_lossy(&output.stdout).contains(daemon::DAEMON_ARG))
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// A daemon on a loopback port that answers Hello, and anything else only
    /// while `answering` is set -- otherwise it reads the request and sits on
    /// it, the way a daemon stuck on its terminal lock does.
    fn fake_daemon(answering: Arc<AtomicBool>) -> Endpoint {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                let answering = Arc::clone(&answering);
                std::thread::spawn(move || serve_fake(stream, answering));
            }
        });
        Endpoint {
            port,
            token: "token".into(),
            // Never a real process: nothing here may signal one.
            pid: 0,
        }
    }

    fn serve_fake(stream: TcpStream, answering: Arc<AtomicBool>) {
        let mut writer = stream.try_clone().unwrap();
        for line in BufReader::new(stream).lines() {
            let Ok(line) = line else { break };
            let envelope: Envelope = serde_json::from_str(&line).unwrap();
            let answer = match envelope.request {
                Request::Hello { .. } => Some(serde_json::json!({ "pid": 0 })),
                Request::ListLiveTerminals if answering.load(Ordering::Acquire) => {
                    Some(serde_json::json!([]))
                }
                _ if answering.load(Ordering::Acquire) => Some(serde_json::Value::Null),
                _ => None,
            };
            if let Some(value) = answer {
                let mut reply = serde_json::to_string(&Message::Ok {
                    id: envelope.id,
                    value,
                })
                .unwrap();
                reply.push('\n');
                if writer.write_all(reply.as_bytes()).is_err() {
                    break;
                }
            }
        }
    }

    fn sinks() -> Sinks {
        Arc::new(Mutex::new(HashMap::new()))
    }

    fn open(endpoint: &Endpoint) -> Arc<Connection> {
        Connection::open(endpoint.clone(), connect_to(endpoint).unwrap(), sinks(), None).unwrap()
    }

    #[test]
    fn a_daemon_that_answers_hello_but_does_no_work_fails_the_handshake() {
        let endpoint = fake_daemon(Arc::new(AtomicBool::new(false)));
        let started = Instant::now();
        assert!(open(&endpoint).handshake().is_err());
        assert!(probe(&endpoint).is_err());
        assert!(started.elapsed() < PROBE_TIMEOUT * 2 + Duration::from_secs(1));
    }

    #[test]
    fn a_daemon_that_does_work_passes_the_handshake() {
        let endpoint = fake_daemon(Arc::new(AtomicBool::new(true)));
        open(&endpoint).handshake().unwrap();
        probe(&endpoint).unwrap();
    }

    #[test]
    fn writes_never_wait_for_the_daemon() {
        // Not even for one that answers nothing: the main thread sends them.
        let endpoint = fake_daemon(Arc::new(AtomicBool::new(false)));
        let client = DaemonClient::with_connection(None, sinks(), open(&endpoint), REQUEST_TIMEOUT);
        let started = Instant::now();
        for _ in 0..100 {
            client.write_terminal("t1", "x").unwrap();
            client.resize_terminal("t1", 80, 24).unwrap();
        }
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn after_one_unanswered_request_the_rest_fail_at_once_until_it_recovers() {
        let answering = Arc::new(AtomicBool::new(false));
        let endpoint = fake_daemon(Arc::clone(&answering));
        let timeout = Duration::from_millis(300);
        let client = DaemonClient::with_connection(None, sinks(), open(&endpoint), timeout);

        assert!(client.live_terminal_ids().is_err());

        // The breaker is open: nothing waits out a timeout, writes included.
        let started = Instant::now();
        assert!(client.live_terminal_ids().is_err());
        assert!(client.write_terminal("t1", "b").is_err());
        assert!(started.elapsed() < Duration::from_millis(100));

        // The health check notices when it answers again, and closes it.
        answering.store(true, Ordering::Release);
        let deadline = Instant::now() + PROBE_INTERVAL + PROBE_TIMEOUT + Duration::from_secs(2);
        while client.current().is_stalled() {
            assert!(Instant::now() < deadline, "never noticed the daemon recover");
            std::thread::sleep(Duration::from_millis(50));
        }
        client.write_terminal("t1", "c").unwrap();
        assert_eq!(client.live_terminal_ids().unwrap(), Vec::<String>::new());
    }

    #[test]
    fn a_closed_connection_fails_at_once() {
        let endpoint = fake_daemon(Arc::new(AtomicBool::new(true)));
        let connection = open(&endpoint);
        connection.close();
        let started = Instant::now();
        assert!(connection.request(Request::ListLiveTerminals, REQUEST_TIMEOUT).is_err());
        assert!(connection
            .notify(Request::ResizeTerminal {
                terminal_id: "t1".into(),
                cols: 80,
                rows: 24,
            })
            .is_err());
        assert!(started.elapsed() < Duration::from_millis(200));
    }

    #[cfg(unix)]
    #[test]
    fn only_a_dispatcher_daemon_is_taken_for_one() {
        // This test binary is running, but it is not a daemon.
        assert!(!is_dispatcher_daemon(std::process::id()));
        assert!(!is_dispatcher_daemon(0));
    }
}
