use crate::errors::PtyError;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

const MAX_POOL_SIZE: usize = 3;

fn preview_terminal_data(data: &str, limit: usize) -> String {
    let mut preview = String::new();
    let mut count = 0usize;

    for ch in data.chars() {
        if count >= limit {
            preview.push('…');
            break;
        }

        match ch {
            '\n' => preview.push_str("\\n"),
            '\r' => preview.push_str("\\r"),
            '\t' => preview.push_str("\\t"),
            '\u{1b}' => preview.push_str("\\x1b"),
            c if c.is_control() => preview.push_str(&format!("\\x{:02x}", c as u32)),
            c => preview.push(c),
        }

        count += 1;
    }

    preview
}

fn should_log_protocol_output(data: &str) -> bool {
    data.contains("\u{1b}P1000p")
        || data.contains("\u{1b}\\")
        || data.contains("%begin ")
        || data.contains("%end ")
        || data.contains("%error ")
        || data.contains("%exit")
        || data.contains("%window-")
        || data.contains("%layout-change ")
        || data.contains("%session-window-changed ")
        || data.contains("%sessions-changed")
        || data.contains("%session-changed ")
}

/// Hand every byte to the session recorder. This is the one place all PTY
/// output passes through, so it is where "what did ssh and tmux actually send
/// us" gets captured.
fn record_output(host: &Arc<dyn PtyHost>, terminal_id: &str, data: &str) {
    host.record_output(terminal_id, data);
}

fn log_protocol_output_chunk(terminal_id: &str, data: &str) {
    if !should_log_protocol_output(data) {
        return;
    }

    let _ = crate::debug_log::append_debug_log(&format!(
        "[backend:pty_output] terminal_id={} bytes={} preview={}",
        terminal_id,
        data.len(),
        preview_terminal_data(data, 200)
    ));
}

fn shell_basename(shell: &str) -> &str {
    shell.rsplit('/').next().unwrap_or(shell)
}

fn remove_agent_environment(cmd: &mut CommandBuilder) {
    let mut removed: Vec<String> = Vec::new();
    let prefixes = [
        "CLAUDE_",
        "CODEX_",
        "CODING_AGENT_",
        "META_3PAI_",
        "META_CLAUDE_",
        "META_CODEX_",
        "OTEL_",
    ];
    let exact_names = [
        "AGENT",
        "BUCK2_CLIENT_METADATA",
        "CPE_RUST_X2P_SUPPORTS_VPNLESS",
        "DOTSLASH_X2P_EDGETERM",
        "ENABLE_AGENTS_CLI_TRACING_THRIFT",
        "ENABLE_ENHANCED_TELEMETRY_BETA",
        "JF_VPNLESS",
        "LINTTOOL_CALLER",
        "OPENAI_API_KEY",
        "X2P_AGENT_PROXY_ADDRESS",
        "X2P_INJECT_CAT",
        "X2P_SUPPORTS_VPNLESS",
    ];

    for name in exact_names {
        if cmd.get_env(name).is_some() {
            cmd.env_remove(name);
            removed.push(name.to_string());
        }
    }

    let prefixed_names: Vec<String> = cmd
        .iter_full_env_as_str()
        .filter_map(|(name, _)| {
            if prefixes.iter().any(|prefix| name.starts_with(prefix)) {
                Some(name.to_string())
            } else {
                None
            }
        })
        .collect();
    for name in prefixed_names {
        cmd.env_remove(&name);
        removed.push(name);
    }

    for name in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
        let should_remove = cmd
            .get_env(name)
            .and_then(|value| value.to_str())
            .map(|value| {
                value.contains("localhost:10054")
                    || value.contains("127.0.0.1:10054")
                    || value.contains("[::1]:10054")
            })
            .unwrap_or(false);
        if should_remove {
            cmd.env_remove(name);
            removed.push(name.to_string());
        }
    }

    if !removed.is_empty() {
        #[cfg(not(test))]
        {
            removed.sort();
            removed.dedup();
            let _ = crate::debug_log::append_debug_log(&format!(
                "[backend:pty_env] removed inherited agent variables names={}",
                removed.join(",")
            ));
        }
    }
}

fn apply_shell_env(cmd: &mut CommandBuilder) {
    remove_agent_environment(cmd);

    // Start each PTY as a clean terminal session instead of inheriting
    // emulator-specific parent metadata from Terminal.app/iTerm/tmux.
    cmd.env("TERM", "xterm-256color");
    cmd.env("TERM_PROGRAM", "Dispatcher");
    cmd.env_remove("TERM_PROGRAM_VERSION");
    cmd.env_remove("TERM_SESSION_ID");
    cmd.env_remove("COLORTERM");
    cmd.env_remove("ITERM_PROFILE");
    cmd.env_remove("ITERM_SESSION_ID");
    cmd.env_remove("LC_TERMINAL");
    cmd.env_remove("LC_TERMINAL_VERSION");
    cmd.env_remove("TERMINAL_EMULATOR");
    cmd.env_remove("TMUX");
    cmd.env_remove("TMUX_PANE");
    cmd.env_remove("STY");
    cmd.env_remove("VTE_VERSION");
    cmd.env_remove("WT_SESSION");

    match shell_basename(&cmd.get_shell()) {
        // Keep bash history effectively unlimited.
        "bash" => {
            cmd.env("HISTSIZE", "999999999");
            cmd.env("HISTFILESIZE", "999999999");
        }
        // Run zsh through a small proxy ZDOTDIR so Dispatcher can preserve the
        // user's existing startup files while restoring the standard Ctrl+R
        // history search binding in app-spawned sessions. Other shells keep
        // their normal startup behavior unless they need a targeted fix.
        "zsh" => {
            if let Err(err) = configure_zsh_startup(cmd) {
                eprintln!("dispatcher: failed to configure zsh startup shim: {err}");
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_inherited_agent_environment_from_pty_commands() {
        let mut cmd = CommandBuilder::new("zsh");
        cmd.env_clear();
        cmd.env("USER", "bobren");
        cmd.env("CODEX_THREAD_ID", "thread");
        cmd.env("CLAUDE_CODE_TMPDIR", "/tmp/claude");
        cmd.env("X2P_AGENT_PROXY_ADDRESS", "localhost:10054");
        cmd.env("DOTSLASH_X2P_EDGETERM", "always");
        cmd.env("HTTP_PROXY", "http://localhost:10054");
        cmd.env("HTTPS_PROXY", "http://corp-proxy.example.com:8080");

        remove_agent_environment(&mut cmd);

        assert_eq!(
            cmd.get_env("USER").and_then(|value| value.to_str()),
            Some("bobren"),
        );
        assert!(cmd.get_env("CODEX_THREAD_ID").is_none());
        assert!(cmd.get_env("CLAUDE_CODE_TMPDIR").is_none());
        assert!(cmd.get_env("X2P_AGENT_PROXY_ADDRESS").is_none());
        assert!(cmd.get_env("DOTSLASH_X2P_EDGETERM").is_none());
        assert!(cmd.get_env("HTTP_PROXY").is_none());
        assert_eq!(
            cmd.get_env("HTTPS_PROXY").and_then(|value| value.to_str()),
            Some("http://corp-proxy.example.com:8080"),
        );
    }
}

fn configure_zsh_startup(cmd: &mut CommandBuilder) -> Result<(), PtyError> {
    let home = cmd
        .get_env("HOME")
        .and_then(|v| v.to_str())
        .ok_or_else(|| PtyError::from(String::from("HOME is not set")))?
        .to_owned();

    let original_zdotdir = cmd
        .get_env("ZDOTDIR")
        .and_then(|v| v.to_str())
        .filter(|v| !v.is_empty())
        .unwrap_or(&home)
        .to_owned();
    let original_histfile = cmd
        .get_env("HISTFILE")
        .and_then(|v| v.to_str())
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| Path::new(&original_zdotdir).join(".zsh_history").to_string_lossy().into_owned());

    let shim_dir = Path::new(&home).join(".dispatcher").join("zsh");
    fs::create_dir_all(&shim_dir).map_err(PtyError::from)?;

    write_zsh_shim_file(
        &shim_dir.join(".zshenv"),
        r#"if [ -n "${DISPATCHER_ORIG_ZDOTDIR:-}" ] && [ -r "${DISPATCHER_ORIG_ZDOTDIR}/.zshenv" ]; then
  . "${DISPATCHER_ORIG_ZDOTDIR}/.zshenv"
fi
"#,
    )?;
    write_zsh_shim_file(
        &shim_dir.join(".zprofile"),
        r#"if [ -n "${DISPATCHER_ORIG_ZDOTDIR:-}" ] && [ -r "${DISPATCHER_ORIG_ZDOTDIR}/.zprofile" ]; then
  . "${DISPATCHER_ORIG_ZDOTDIR}/.zprofile"
fi
"#,
    )?;
    write_zsh_shim_file(
        &shim_dir.join(".zshrc"),
        r#"if [ -n "${DISPATCHER_ORIG_HISTFILE:-}" ]; then
  HISTFILE="${DISPATCHER_ORIG_HISTFILE}"
  export HISTFILE
fi
if [ -n "${DISPATCHER_ORIG_ZDOTDIR:-}" ] && [ -r "${DISPATCHER_ORIG_ZDOTDIR}/.zshrc" ]; then
  . "${DISPATCHER_ORIG_ZDOTDIR}/.zshrc"
fi
if [ -n "${HISTFILE:-}" ] && [ -r "${HISTFILE}" ]; then
  fc -R "${HISTFILE}" 2>/dev/null || true
fi
bindkey '^R' history-incremental-search-backward 2>/dev/null || true
bindkey -M emacs '^R' history-incremental-search-backward 2>/dev/null || true
bindkey -M viins '^R' history-incremental-search-backward 2>/dev/null || true
"#,
    )?;
    write_zsh_shim_file(
        &shim_dir.join(".zlogin"),
        r#"if [ -n "${DISPATCHER_ORIG_ZDOTDIR:-}" ] && [ -r "${DISPATCHER_ORIG_ZDOTDIR}/.zlogin" ]; then
  . "${DISPATCHER_ORIG_ZDOTDIR}/.zlogin"
fi
"#,
    )?;

    cmd.env("DISPATCHER_ORIG_ZDOTDIR", &original_zdotdir);
    cmd.env("DISPATCHER_ORIG_HISTFILE", &original_histfile);
    cmd.env("ZDOTDIR", shim_dir.as_os_str());

    Ok(())
}

fn write_zsh_shim_file(path: &PathBuf, content: &str) -> Result<(), PtyError> {
    fs::write(path, content).map_err(PtyError::from)
}

fn clear_problematic_control_chars(master: &dyn MasterPty) {
    #[cfg(unix)]
    if let Some(fd) = master.as_raw_fd() {
        let mut termios = unsafe { std::mem::MaybeUninit::<libc::termios>::zeroed().assume_init() };
        if unsafe { libc::tcgetattr(fd, &mut termios) } == 0 {
            let disabled = libc::_POSIX_VDISABLE;
            termios.c_cc[libc::VREPRINT] = disabled;
            termios.c_cc[libc::VDISCARD] = disabled;
            unsafe {
                let _ = libc::tcsetattr(fd, libc::TCSANOW, &termios);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// UTF-8 streaming helper
// ---------------------------------------------------------------------------

/// Find the byte index at which to split a buffer so that everything before the
/// index is complete UTF-8.  Any trailing bytes that form an incomplete
/// multi-byte sequence are left for the caller to carry over to the next read.
///
/// This prevents `from_utf8_lossy` from destroying characters that straddle
/// a 4096-byte read boundary.
fn utf8_split_point(bytes: &[u8]) -> usize {
    let len = bytes.len();
    if len == 0 {
        return 0;
    }

    // UTF-8 multi-byte sequences are at most 4 bytes.  We only need to
    // inspect the last 1–3 bytes to decide whether the buffer ends with
    // an incomplete character.
    //
    //   0xxxxxxx  →  1-byte (ASCII), always complete
    //   110xxxxx  →  2-byte lead
    //   1110xxxx  →  3-byte lead
    //   11110xxx  →  4-byte lead
    //   10xxxxxx  →  continuation byte

    let check = std::cmp::min(3, len);
    for back in 1..=check {
        let i = len - back;
        let b = bytes[i];

        if b & 0x80 == 0 {
            // ASCII — everything up to and including this byte is complete.
            return len;
        }

        if b & 0xC0 != 0x80 {
            // Leading byte found.
            let expected = if b & 0xF8 == 0xF0 {
                4
            } else if b & 0xF0 == 0xE0 {
                3
            } else {
                2
            };
            let actual = len - i;
            if actual >= expected {
                // Character is complete.
                return len;
            }
            // Incomplete — split before this lead byte.
            return i;
        }
        // Continuation byte — keep scanning backwards.
    }

    // All inspected bytes are continuation bytes (shouldn't happen in valid
    // UTF-8).  Pass everything through and let lossy conversion handle it.
    len
}

// -- Output routing for reader threads --

/// Everything the PTY layer needs from whatever is hosting it.
///
/// In the desktop process that is Tauri. In the daemon it is the socket to the
/// app that is currently attached. Keeping it behind a trait is what lets the
/// same PTY code run in either, so terminals can outlive the window.
pub trait PtyHost: Send + Sync + 'static {
    fn record_output(&self, terminal_id: &str, data: &str);
    fn record_input(&self, terminal_id: &str, data: &str);
    fn record_event(&self, name: &str, payload: serde_json::Value);
    fn terminal_exited(&self, terminal_id: &str, exit_code: Option<i32>);
}

/// Where one terminal's output goes. Returns false once the consumer is gone,
/// which leaves the PTY running and still recording for the next attach.
pub trait OutputSink: Send + Sync {
    fn send(&self, terminal_id: &str, data: &str) -> bool;
}

/// Used before a host is installed, and in tests.
pub struct NullPtyHost;

impl PtyHost for NullPtyHost {
    fn record_output(&self, _terminal_id: &str, _data: &str) {}
    fn record_input(&self, _terminal_id: &str, _data: &str) {}
    fn record_event(&self, _name: &str, _payload: serde_json::Value) {}
    fn terminal_exited(&self, _terminal_id: &str, _exit_code: Option<i32>) {}
}

/// How much output each terminal remembers so a reconnecting UI can be shown
/// what it missed instead of starting from a blank screen.
const REPLAY_LIMIT_BYTES: usize = 256 * 1024;

enum OutputMode {
    /// PTY is pooled; buffer all output until assigned.
    Buffering(Vec<u8>),
    /// PTY is assigned to a real terminal; stream to whichever UI is attached.
    Streaming { terminal_id: String },
}

/// Where a PTY's output goes, and what it remembers.
///
/// The channel is deliberately optional and swappable: the UI owning it is far
/// more fragile than the process on the other end of the pty. A page reload
/// replaces the channel; it must not disturb the shell, the ssh connection, or
/// the tmux client behind it.
struct OutputRouter {
    mode: OutputMode,
    assigned_id: Option<String>,
    channel: Option<Box<dyn OutputSink>>,
    replay: Vec<u8>,
}

impl OutputRouter {
    fn new_buffering() -> Self {
        OutputRouter {
            mode: OutputMode::Buffering(Vec::with_capacity(4096)),
            assigned_id: None,
            channel: None,
            replay: Vec::new(),
        }
    }

    fn record_replay(&mut self, bytes: &[u8]) {
        self.replay.extend_from_slice(bytes);
        if self.replay.len() <= REPLAY_LIMIT_BYTES * 2 {
            return;
        }

        // Trim on a line boundary when one is nearby so a replay does not begin
        // in the middle of an escape sequence.
        let excess = self.replay.len() - REPLAY_LIMIT_BYTES;
        let window_end = std::cmp::min(self.replay.len(), excess + 4096);
        let cut = self.replay[excess..window_end]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|offset| excess + offset + 1)
            .unwrap_or(excess);
        self.replay.drain(..cut);
    }

    fn emit(&mut self, terminal_id: &str, data: String) {
        if let Some(sink) = &self.channel {
            if !sink.send(terminal_id, &data) {
                // The UI went away. Keep the PTY running and keep recording;
                // the next attach replays what was missed.
                self.channel = None;
            }
        }
    }
}

/// Reader thread: buffers output while the PTY is pooled, streams it to
/// whichever UI is attached once assigned, and always records it for replay.
/// Uses a carry buffer so multi-byte UTF-8 straddling a 4096-byte read boundary
/// is not corrupted.
fn spawn_reader_thread(
    host: Arc<dyn PtyHost>,
    mut reader: Box<dyn Read + Send>,
    router: Arc<Mutex<OutputRouter>>,
    child_arc: Arc<Mutex<Option<Box<dyn Child + Send + Sync>>>>,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut carry: Vec<u8> = Vec::new();

        let dispatch = |bytes: &[u8]| {
            let mut r = router.lock().unwrap();
            match &mut r.mode {
                OutputMode::Buffering(buffer) => buffer.extend_from_slice(bytes),
                OutputMode::Streaming { terminal_id } => {
                    let terminal_id = terminal_id.clone();
                    let data = String::from_utf8_lossy(bytes).to_string();
                    log_protocol_output_chunk(&terminal_id, &data);
                    record_output(&host, &terminal_id, &data);
                    r.record_replay(bytes);
                    r.emit(&terminal_id, data);
                }
            }
        };

        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    let split = utf8_split_point(&carry);
                    if split > 0 {
                        dispatch(&carry[..split]);
                    }
                    carry.drain(..split);
                }
                Err(_) => break,
            }
        }

        if !carry.is_empty() {
            dispatch(&carry);
        }

        let exit_code = {
            let mut guard = child_arc.lock().unwrap();
            if let Some(ref mut child) = *guard {
                child.wait().ok().map(|status| status.exit_code() as i32)
            } else {
                None
            }
        };

        let assigned_id = router.lock().unwrap().assigned_id.clone();
        if let Some(terminal_id) = assigned_id {
            host.terminal_exited(&terminal_id, exit_code);
        }
    });
}

// -- Session types --

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Arc<Mutex<Option<Box<dyn Child + Send + Sync>>>>,
    router: Arc<Mutex<OutputRouter>>,
}

struct PoolEntry {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Arc<Mutex<Option<Box<dyn Child + Send + Sync>>>>,
    router: Arc<Mutex<OutputRouter>>,
}

pub struct PtyManager {
    host: std::sync::OnceLock<Arc<dyn PtyHost>>,
    sessions: Mutex<HashMap<String, PtySession>>,
    pool: Mutex<Vec<PoolEntry>>,
}

impl PtyManager {
    pub fn new() -> Self {
        PtyManager {
            host: std::sync::OnceLock::new(),
            sessions: Mutex::new(HashMap::new()),
            pool: Mutex::new(Vec::new()),
        }
    }

    /// Install the host. Done once during setup, because the Tauri handle does
    /// not exist when this manager is constructed.
    pub fn set_host(&self, host: Arc<dyn PtyHost>) {
        let _ = self.host.set(host);
    }

    fn host(&self) -> Arc<dyn PtyHost> {
        self.host
            .get()
            .cloned()
            .unwrap_or_else(|| Arc::new(NullPtyHost) as Arc<dyn PtyHost>)
    }

    /// Pre-spawn PTYs into the pool, up to MAX_POOL_SIZE total.
    pub fn warm_pool(&self, count: usize) -> Result<(), PtyError> {
        let current = self.pool.lock().unwrap().len();
        let to_spawn = count.min(MAX_POOL_SIZE.saturating_sub(current));
        for _ in 0..to_spawn {
            self.spawn_to_pool()?;
        }
        Ok(())
    }

    /// Drain all pooled PTYs and spawn fresh replacements so that shell
    /// history, environment variables, etc. are up-to-date.
    pub fn refresh_pool(&self) -> Result<(), PtyError> {
        let old: Vec<PoolEntry> = {
            let mut pool = self.pool.lock().unwrap();
            pool.drain(..).collect()
        };
        // Kill old shell processes.
        for entry in old {
            if let Some(mut child) = entry.child.lock().unwrap().take() {
                let _ = child.kill();
            }
            // Dropping master/writer closes the PTY fds; the reader thread
            // will see EOF and exit on its own.
        }
        self.warm_pool(MAX_POOL_SIZE)
    }

    fn spawn_to_pool(&self) -> Result<(), PtyError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(PtyError::from)?;
        clear_problematic_control_chars(&*pair.master);

        let mut cmd = CommandBuilder::new_default_prog();
        apply_shell_env(&mut cmd);

        let child = pair.slave.spawn_command(cmd).map_err(PtyError::from)?;
        drop(pair.slave);

        let writer = pair.master.take_writer().map_err(PtyError::from)?;
        let reader = pair.master.try_clone_reader().map_err(PtyError::from)?;

        let child_arc: Arc<Mutex<Option<Box<dyn Child + Send + Sync>>>> =
            Arc::new(Mutex::new(Some(child)));

        let router = Arc::new(Mutex::new(OutputRouter::new_buffering()));

        let entry = PoolEntry {
            master: pair.master,
            writer,
            child: Arc::clone(&child_arc),
            router: Arc::clone(&router),
        };

        self.pool.lock().unwrap().push(entry);

        spawn_reader_thread(self.host(), reader, router, child_arc);

        Ok(())
    }

    /// Start the terminal, or — when it is already running — hand the existing
    /// one to the new channel.
    ///
    /// A page reload throws away the old channel and asks for every terminal
    /// again. Recreating them would kill the shell, and with it any ssh
    /// connection and tmux client behind it, which is expensive to rebuild by
    /// hand. Reattaching keeps all of that and replays what the UI missed.
    pub fn create_terminal(
        &self,
        terminal_id: String,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        channel: Box<dyn OutputSink>,
    ) -> Result<(), PtyError> {
        // Hand the sink over; it comes back only if there was nothing to
        // reattach to, since reattaching consumes it.
        let Some(channel) = self.reattach_terminal(&terminal_id, cols, rows, channel)? else {
            return Ok(());
        };

        let has_cwd = cwd.as_ref().map_or(false, |d| !d.is_empty());

        // Try pool first — even when cwd is specified we can cd into it
        let entry = self.pool.lock().unwrap().pop();
        if let Some(entry) = entry {
            // Resize to actual dimensions FIRST, before replaying buffered
            // output.  The pool PTY starts at 80×24; if the frontend is a
            // different size the replayed content would use wrong line wrapping.
            let _ = entry.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });

            // Switch router from buffering to streaming
            {
                let mut r = entry.router.lock().unwrap();
                r.channel = Some(channel);
                if !has_cwd {
                    // No custom cwd — replay buffered output (initial prompt etc.)
                    let buffered = match r.mode {
                        OutputMode::Buffering(ref buffer) => buffer.clone(),
                        OutputMode::Streaming { .. } => Vec::new(),
                    };
                    if !buffered.is_empty() {
                        r.record_replay(&buffered);
                        let data = String::from_utf8_lossy(&buffered).to_string();
                        r.emit(&terminal_id, data);
                    }
                }
                // When has_cwd is true we discard the buffer — the cd+clear
                // below will produce a fresh prompt in the right directory.
                r.mode = OutputMode::Streaming {
                    terminal_id: terminal_id.clone(),
                };
                r.assigned_id = Some(terminal_id.clone());
            }

            let mut session = PtySession {
                master: entry.master,
                writer: entry.writer,
                child: entry.child,
                router: Arc::clone(&entry.router),
            };

            // cd into the requested directory and clear the screen so the
            // user sees a clean prompt.  Leading space keeps this out of
            // shell history (HISTCONTROL=ignorespace / HIST_IGNORE_SPACE).
            if let Some(ref dir) = cwd {
                if !dir.is_empty() {
                    let escaped = dir.replace('\'', "'\\''");
                    let cmd = format!(" cd '{}' && clear\n", escaped);
                    let _ = session.writer.write_all(cmd.as_bytes());
                    let _ = session.writer.flush();
                }
            }

            self.sessions.lock().unwrap().insert(terminal_id, session);
            return Ok(());
        }

        // Pool empty — spawn fresh
        self.spawn_fresh(terminal_id, cwd, cols, rows, channel)
    }

    fn spawn_fresh(
        &self,
        terminal_id: String,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        channel: Box<dyn OutputSink>,
    ) -> Result<(), PtyError> {
        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::from(e))?;
        clear_problematic_control_chars(&*pair.master);

        let mut cmd = CommandBuilder::new_default_prog();
        apply_shell_env(&mut cmd);
        if let Some(ref dir) = cwd {
            cmd.cwd(dir);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| PtyError::from(e))?;
        drop(pair.slave);

        let writer = pair.master.take_writer().map_err(|e| PtyError::from(e))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| PtyError::from(e))?;

        let child_arc: Arc<Mutex<Option<Box<dyn Child + Send + Sync>>>> =
            Arc::new(Mutex::new(Some(child)));

        let router = Arc::new(Mutex::new(OutputRouter::new_buffering()));
        {
            let mut r = router.lock().unwrap();
            r.mode = OutputMode::Streaming {
                terminal_id: terminal_id.clone(),
            };
            r.assigned_id = Some(terminal_id.clone());
            r.channel = Some(channel);
        }

        let session = PtySession {
            master: pair.master,
            writer,
            child: Arc::clone(&child_arc),
            router: Arc::clone(&router),
        };

        {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.insert(terminal_id.clone(), session);
        }

        spawn_reader_thread(self.host(), reader, router, child_arc);

        Ok(())
    }

    /// Point an existing terminal at a new sink and replay what the previous UI
    /// missed. Returns the sink back when there is no such terminal, so the
    /// caller can go on to spawn one.
    fn reattach_terminal(
        &self,
        terminal_id: &str,
        cols: u16,
        rows: u16,
        channel: Box<dyn OutputSink>,
    ) -> Result<Option<Box<dyn OutputSink>>, PtyError> {
        let sessions = self.sessions.lock().unwrap();
        let Some(session) = sessions.get(terminal_id) else {
            return Ok(Some(channel));
        };

        // Match the new UI's geometry before replaying, so the replayed output
        // wraps the way the terminal will render it.
        let _ = session.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });

        let mut r = session.router.lock().unwrap();
        r.channel = Some(channel);
        let replay = String::from_utf8_lossy(&r.replay).to_string();
        let replay_bytes = replay.len();
        if !replay.is_empty() {
            r.emit(terminal_id, replay);
        }
        drop(r);
        drop(sessions);

        let _ = crate::debug_log::append_debug_log(&format!(
            "[backend:reattach_terminal] terminal_id={} cols={} rows={} replay_bytes={}",
            terminal_id, cols, rows, replay_bytes
        ));
        Ok(None)
    }

    /// Terminals whose PTY is still running. The UI uses this after a reload to
    /// tell a live session from one that only exists in saved state.
    pub fn live_terminal_ids(&self) -> Vec<String> {
        self.sessions.lock().unwrap().keys().cloned().collect()
    }

    pub fn write_terminal(
        &self,
        terminal_id: &str,
        data: &[u8],
    ) -> Result<(), PtyError> {
        self.host()
            .record_input(terminal_id, &String::from_utf8_lossy(data));

        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(terminal_id)
            .ok_or_else(|| PtyError::from(format!("Terminal {} not found", terminal_id)))?;
        session
            .writer
            .write_all(data)
            .map_err(|e| PtyError::from(e))?;
        session.writer.flush().map_err(|e| PtyError::from(e))?;
        Ok(())
    }

    pub fn get_terminal_debug_info(&self, terminal_id: &str) -> Result<TerminalDebugInfo, PtyError> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(terminal_id)
            .ok_or_else(|| PtyError::from(format!("Terminal {} not found", terminal_id)))?;

        #[cfg(unix)]
        {
            let mut foreground_pgid = None;
            let mut foreground_command = None;
            let mut vdiscard = None;
            let mut vreprint = None;

            if let Some(fd) = session.master.as_raw_fd() {
                let pgid = unsafe { libc::tcgetpgrp(fd) };
                if pgid > 0 {
                    foreground_pgid = Some(pgid);
                    foreground_command = Command::new("ps")
                        .args(["-o", "comm=", "-p", &pgid.to_string()])
                        .output()
                        .ok()
                        .and_then(|output| {
                            if !output.status.success() {
                                return None;
                            }
                            let cmd = String::from_utf8_lossy(&output.stdout).trim().to_owned();
                            if cmd.is_empty() { None } else { Some(cmd) }
                        });
                }

                let mut termios = unsafe { std::mem::MaybeUninit::<libc::termios>::zeroed().assume_init() };
                if unsafe { libc::tcgetattr(fd, &mut termios) } == 0 {
                    vdiscard = Some(termios.c_cc[libc::VDISCARD]);
                    vreprint = Some(termios.c_cc[libc::VREPRINT]);
                }
            }

            return Ok(TerminalDebugInfo {
                terminal_id: terminal_id.to_owned(),
                foreground_pgid,
                foreground_command,
                vdiscard,
                vreprint,
            });
        }

        #[cfg(not(unix))]
        {
            Ok(TerminalDebugInfo {
                terminal_id: terminal_id.to_owned(),
                foreground_pgid: None,
                foreground_command: None,
                vdiscard: None,
                vreprint: None,
            })
        }
    }

    pub fn resize_terminal(
        &self,
        terminal_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), PtyError> {
        self.host().record_event(
            "resize",
            serde_json::json!({ "terminalId": terminal_id, "cols": cols, "rows": rows }),
        );

        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(terminal_id)
            .ok_or_else(|| PtyError::from(format!("Terminal {} not found", terminal_id)))?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::from(e))?;
        Ok(())
    }

    pub fn get_terminal_cwd(&self, terminal_id: &str) -> Result<Option<String>, PtyError> {
        // Extract the PID while holding the lock, then drop it before running
        // lsof.  Previously the sessions lock was held across the lsof call,
        // blocking all other PTY operations (create, write, resize, close).
        let pid = {
            let sessions = self.sessions.lock().unwrap();
            let session = sessions
                .get(terminal_id)
                .ok_or_else(|| PtyError::from(format!("Terminal {} not found", terminal_id)))?;
            let child_guard = session.child.lock().unwrap();
            child_guard.as_ref().and_then(|c| c.process_id())
        };

        match pid {
            Some(pid) => {
                let output = std::process::Command::new("lsof")
                    .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
                    .output();

                match output {
                    Ok(output) => {
                        let stdout = String::from_utf8_lossy(&output.stdout);
                        for line in stdout.lines() {
                            if let Some(path) = line.strip_prefix('n') {
                                return Ok(Some(path.to_string()));
                            }
                        }
                        Ok(None)
                    }
                    Err(_) => Ok(None),
                }
            }
            None => Ok(None),
        }
    }

    pub fn close_terminal(&self, terminal_id: &str) -> Result<(), PtyError> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.remove(terminal_id) {
            let mut guard = session.child.lock().unwrap();
            if let Some(ref mut child) = *guard {
                let _ = child.kill();
            }
        }
        Ok(())
    }
}

#[derive(Clone, serde::Serialize)]
pub struct TerminalOutput {
    pub terminal_id: String,
    pub data: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct TerminalDebugInfo {
    pub terminal_id: String,
    pub foreground_pgid: Option<i32>,
    pub foreground_command: Option<String>,
    pub vdiscard: Option<u8>,
    pub vreprint: Option<u8>,
}

#[derive(Clone, serde::Serialize)]
pub struct TerminalExitPayload {
    pub terminal_id: String,
    pub exit_code: Option<i32>,
}
