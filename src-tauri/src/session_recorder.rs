//! Records terminal sessions to disk so a rendering bug can be inspected — and
//! replayed — after the fact.
//!
//! The existing debug log only keeps short previews of chunks that look like
//! tmux control traffic, which is no use when the question is "why did this
//! pane draw wrong". Diagnosing that needs the actual bytes, in order, with
//! timing. So each run writes:
//!
//! ```text
//! recordings/<run>/
//!   index.json              what each recording is: tab title, backend, tmux ids
//!   events.jsonl            resizes, creates, exits — the things that reshape a pane
//!   transport-<id>.cast     raw PTY bytes: exactly what ssh and tmux sent us
//!   pane-<id>.cast          bytes written into one pane's terminal, post-decode
//! ```
//!
//! `.cast` files are asciinema v2, so they can be read as plain JSON lines or
//! replayed with `asciinema play` to watch the bug happen.
//!
//! For a local shell the transport and the pane stream are the same bytes, so
//! only the transport is recorded. For tmux the two differ in the way that
//! matters: the transport is one multiplexed control stream, while the pane
//! stream is what a given pane's terminal actually received once that stream
//! was decoded. Rendering follows the latter; the former says whether the
//! remote is at fault.

use crate::errors::PtyError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Stop appending to a single recording past this size. One runaway `cat` of a
/// large file should not evict every other recording.
const MAX_RECORDING_BYTES: u64 = 24 * 1024 * 1024;
/// Runs to keep before the oldest are deleted.
const MAX_RUNS_KEPT: usize = 12;
/// Ceiling for everything under `recordings/`.
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn now_unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// Keep ids and titles safe to use as file names.
fn sanitize(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' => ch,
            _ => '_',
        })
        .collect();
    let trimmed: String = cleaned.chars().take(64).collect();
    // "." and ".." are legal after the character filter but are not usable as a
    // file name component.
    if trimmed.is_empty() || trimmed.chars().all(|ch| ch == '.') {
        "unknown".to_string()
    } else {
        trimmed
    }
}

pub fn recordings_root() -> PathBuf {
    crate::debug_log::debug_log_path()
        .parent()
        .map(|parent| parent.join("recordings"))
        .unwrap_or_else(|| std::env::temp_dir().join("dispatcher-recordings"))
}

/// One open `.cast` file.
struct Recording {
    file: File,
    bytes: u64,
    truncated: bool,
}

impl Recording {
    fn create(path: &Path, title: &str, started_at: u64) -> Result<Self, PtyError> {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(path)?;

        // asciinema v2 header. Width/height are a hint only; the real geometry
        // shows up in events.jsonl as it changes.
        let header = json!({
            "version": 2,
            "width": 80,
            "height": 24,
            "timestamp": started_at,
            "title": title,
            "env": { "TERM": "xterm-256color" },
        });
        writeln!(file, "{header}")?;

        Ok(Recording {
            file,
            bytes: 0,
            truncated: false,
        })
    }

    fn append(&mut self, elapsed: f64, kind: &str, data: &str) {
        if self.truncated {
            return;
        }

        if self.bytes >= MAX_RECORDING_BYTES {
            self.truncated = true;
            let note = json!([elapsed, "o", "\r\n[dispatcher: recording size limit reached]\r\n"]);
            let _ = writeln!(self.file, "{note}");
            return;
        }

        let line = json!([elapsed, kind, data]);
        if writeln!(self.file, "{line}").is_ok() {
            self.bytes += data.len() as u64;
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneChunk {
    pub terminal_id: String,
    /// Milliseconds since the epoch, taken when the chunk was written.
    pub at: f64,
    pub data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    pub enabled: bool,
    pub directory: String,
    pub recordings: usize,
}

pub struct SessionRecorder {
    enabled: AtomicBool,
    run_dir: PathBuf,
    started_at_unix: u64,
    started_at_millis: u128,
    files: Mutex<HashMap<String, Recording>>,
    index: Mutex<HashMap<String, Value>>,
}

impl SessionRecorder {
    pub fn new() -> Self {
        // Opt out with DISPATCHER_RECORD=0; recordings contain full terminal
        // output, which is the point but is worth being able to turn off.
        let enabled = std::env::var("DISPATCHER_RECORD")
            .map(|value| value != "0" && !value.eq_ignore_ascii_case("false"))
            .unwrap_or(true);

        let started_at_unix = now_unix_secs();
        let run_dir = recordings_root().join(format!("{}-{}", started_at_unix, std::process::id()));

        if enabled {
            let _ = fs::create_dir_all(&run_dir);
            prune_old_runs();
            let _ = crate::debug_log::append_debug_log(&format!(
                "[backend:recorder] recording session to {}",
                run_dir.display()
            ));
        }

        SessionRecorder {
            enabled: AtomicBool::new(enabled),
            run_dir,
            started_at_unix,
            started_at_millis: now_unix_millis(),
            files: Mutex::new(HashMap::new()),
            index: Mutex::new(HashMap::new()),
        }
    }

    fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    fn elapsed_from_millis(&self, at_millis: u128) -> f64 {
        at_millis.saturating_sub(self.started_at_millis) as f64 / 1000.0
    }

    fn elapsed_now(&self) -> f64 {
        self.elapsed_from_millis(now_unix_millis())
    }

    fn with_recording<F>(&self, key: String, file_name: String, title: &str, apply: F)
    where
        F: FnOnce(&mut Recording),
    {
        if !self.is_enabled() {
            return;
        }

        let mut files = self.files.lock().unwrap();
        if !files.contains_key(&key) {
            let path = self.run_dir.join(&file_name);
            match Recording::create(&path, title, self.started_at_unix) {
                Ok(recording) => {
                    files.insert(key.clone(), recording);
                }
                Err(err) => {
                    let _ = crate::debug_log::append_debug_log(&format!(
                        "[backend:recorder:error] could not open {} error={}",
                        path.display(),
                        err.message
                    ));
                    return;
                }
            }
        }

        if let Some(recording) = files.get_mut(&key) {
            apply(recording);
        }
    }

    /// Raw bytes off the PTY — for an ssh + tmux tab, the control-mode stream.
    pub fn record_transport_output(&self, terminal_id: &str, data: &str) {
        let elapsed = self.elapsed_now();
        self.with_recording(
            format!("transport:{terminal_id}"),
            format!("transport-{}.cast", sanitize(terminal_id)),
            terminal_id,
            |recording| recording.append(elapsed, "o", data),
        );
    }

    /// Bytes we sent: keystrokes, and the tmux commands we issue.
    pub fn record_transport_input(&self, terminal_id: &str, data: &str) {
        let elapsed = self.elapsed_now();
        self.with_recording(
            format!("transport:{terminal_id}"),
            format!("transport-{}.cast", sanitize(terminal_id)),
            terminal_id,
            |recording| recording.append(elapsed, "i", data),
        );
    }

    /// Bytes the frontend wrote into a pane's terminal, after decoding tmux.
    pub fn record_pane_output(&self, chunks: Vec<PaneChunk>) {
        for chunk in chunks {
            let elapsed = self.elapsed_from_millis(chunk.at as u128);
            self.with_recording(
                format!("pane:{}", chunk.terminal_id),
                format!("pane-{}.cast", sanitize(&chunk.terminal_id)),
                &chunk.terminal_id,
                |recording| recording.append(elapsed, "o", &chunk.data),
            );
        }
    }

    /// Anything that reshapes a pane, which is most of what breaks rendering.
    pub fn record_event(&self, kind: &str, detail: Value) {
        if !self.is_enabled() {
            return;
        }

        let line = json!({
            "at": self.elapsed_now(),
            "kind": kind,
            "detail": detail,
        });

        let path = self.run_dir.join("events.jsonl");
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{line}");
        }
    }

    /// Records what a terminal *is*, so a recording can be matched to the tab
    /// the user is complaining about.
    pub fn describe_terminal(&self, terminal_id: &str, description: Value) {
        if !self.is_enabled() {
            return;
        }

        {
            let mut index = self.index.lock().unwrap();
            index.insert(terminal_id.to_string(), description);
        }
        self.write_index();
    }

    fn write_index(&self) {
        let index = self.index.lock().unwrap();
        let entries: Vec<Value> = index
            .iter()
            .map(|(terminal_id, description)| {
                json!({
                    "terminalId": terminal_id,
                    "transport": format!("transport-{}.cast", sanitize(terminal_id)),
                    "pane": format!("pane-{}.cast", sanitize(terminal_id)),
                    "description": description,
                })
            })
            .collect();

        let body = json!({
            "startedAt": self.started_at_unix,
            "pid": std::process::id(),
            "terminals": entries,
        });

        let _ = fs::write(
            self.run_dir.join("index.json"),
            serde_json::to_vec_pretty(&body).unwrap_or_default(),
        );
    }

    pub fn info(&self) -> RecordingInfo {
        RecordingInfo {
            enabled: self.is_enabled(),
            directory: self.run_dir.display().to_string(),
            recordings: self.files.lock().unwrap().len(),
        }
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
        if enabled {
            let _ = fs::create_dir_all(&self.run_dir);
        }
    }
}

impl Default for SessionRecorder {
    fn default() -> Self {
        Self::new()
    }
}

fn directory_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.metadata() {
            Ok(metadata) if metadata.is_dir() => directory_size(&entry.path()),
            Ok(metadata) => metadata.len(),
            Err(_) => 0,
        })
        .sum()
}

/// Keep the most recent runs, within a total size ceiling.
fn prune_old_runs() {
    let root = recordings_root();
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };

    let mut runs: Vec<(PathBuf, SystemTime)> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| {
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(UNIX_EPOCH);
            (entry.path(), modified)
        })
        .collect();

    runs.sort_by(|a, b| b.1.cmp(&a.1));

    let mut kept_bytes = 0u64;
    let mut removed = 0usize;
    for (index, (path, _)) in runs.iter().enumerate() {
        kept_bytes = kept_bytes.saturating_add(directory_size(path));
        if index < MAX_RUNS_KEPT && kept_bytes <= MAX_TOTAL_BYTES {
            continue;
        }
        if fs::remove_dir_all(path).is_ok() {
            removed += 1;
        }
    }

    if removed > 0 {
        let _ = crate::debug_log::append_debug_log(&format!(
            "[backend:recorder] pruned {removed} old recording run(s)"
        ));
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

use tauri::{AppHandle, Manager};

/// The frontend batches pane writes and flushes them here; only tmux-backed
/// panes need it, since a local shell's pane stream is its transport stream.
#[tauri::command]
pub fn record_pane_output(app_handle: AppHandle, chunks: Vec<PaneChunk>) -> Result<(), PtyError> {
    app_handle
        .state::<SessionRecorder>()
        .record_pane_output(chunks);
    Ok(())
}

#[tauri::command]
pub fn record_session_event(
    app_handle: AppHandle,
    kind: String,
    detail: Value,
) -> Result<(), PtyError> {
    app_handle
        .state::<SessionRecorder>()
        .record_event(&kind, detail);
    Ok(())
}

/// Names a terminal in index.json so a recording can be traced back to the tab.
#[tauri::command]
pub fn describe_recorded_terminal(
    app_handle: AppHandle,
    terminal_id: String,
    description: Value,
) -> Result<(), PtyError> {
    app_handle
        .state::<SessionRecorder>()
        .describe_terminal(&terminal_id, description);
    Ok(())
}

#[tauri::command]
pub fn get_recording_info(app_handle: AppHandle) -> Result<RecordingInfo, PtyError> {
    Ok(app_handle.state::<SessionRecorder>().info())
}

#[tauri::command]
pub fn set_recording_enabled(app_handle: AppHandle, enabled: bool) -> Result<(), PtyError> {
    app_handle.state::<SessionRecorder>().set_enabled(enabled);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("dispatcher-recorder-test-{}-{}", std::process::id(), name))
    }

    #[test]
    fn sanitize_keeps_ids_usable_as_file_names() {
        assert_eq!(sanitize("abc-123_x.y"), "abc-123_x.y");
        assert_eq!(sanitize("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(sanitize(".."), "unknown");
        assert_eq!(sanitize("."), "unknown");
        assert_eq!(sanitize(""), "unknown");
        assert_eq!(sanitize(&"a".repeat(200)).len(), 64);
    }

    #[test]
    fn recording_starts_with_an_asciinema_header() {
        let path = temp_path("header.cast");
        let _ = fs::remove_file(&path);
        Recording::create(&path, "my tab", 1_700_000_000).unwrap();

        let contents = fs::read_to_string(&path).unwrap();
        let header: Value = serde_json::from_str(contents.lines().next().unwrap()).unwrap();
        assert_eq!(header["version"], 2);
        assert_eq!(header["title"], "my tab");
        assert_eq!(header["timestamp"], 1_700_000_000u64);

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn events_are_written_as_one_json_line_each() {
        let path = temp_path("events.cast");
        let _ = fs::remove_file(&path);
        let mut recording = Recording::create(&path, "t", 0).unwrap();
        recording.append(1.5, "o", "hello\r\n");
        recording.append(2.0, "i", "q");

        let contents = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = contents.lines().skip(1).collect();
        assert_eq!(lines.len(), 2);

        let first: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first[0], 1.5);
        assert_eq!(first[1], "o");
        assert_eq!(first[2], "hello\r\n");

        let second: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(second[1], "i");

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_runaway_terminal_stops_at_the_size_cap() {
        let path = temp_path("cap.cast");
        let _ = fs::remove_file(&path);
        let mut recording = Recording::create(&path, "t", 0).unwrap();

        let chunk = "x".repeat(1024 * 1024);
        for _ in 0..40 {
            recording.append(0.0, "o", &chunk);
        }

        assert!(recording.truncated, "should stop once past the cap");
        let contents = fs::read_to_string(&path).unwrap();
        assert!(contents.contains("recording size limit reached"));
        // Bounded rather than unbounded: the cap plus the one chunk that crossed it.
        assert!(recording.bytes <= MAX_RECORDING_BYTES + chunk.len() as u64);

        let _ = fs::remove_file(&path);
    }
}
