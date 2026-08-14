use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const RUN_MARKER_PREFIX: &str = "dispatcher-running-";

pub struct RunMarker {
    path: PathBuf,
}

fn unix_timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn process_is_running(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // Signal 0 only checks for the process; it does not deliver a signal.
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        return result == 0
            || std::io::Error::last_os_error().kind() == std::io::ErrorKind::PermissionDenied;
    }

    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

fn marker_pid(path: &Path) -> Option<u32> {
    let name = path.file_name()?.to_str()?;
    name.strip_prefix(RUN_MARKER_PREFIX)?
        .strip_suffix(".json")?
        .parse()
        .ok()
}

pub fn mark_run_started() -> Option<RunMarker> {
    let log_path = crate::debug_log::debug_log_path();
    let dir = log_path.parent()?;
    if let Err(err) = fs::create_dir_all(dir) {
        let _ = crate::debug_log::append_debug_log(&format!(
            "[backend:run_state:error] failed to create diagnostics directory error={}",
            err
        ));
        return None;
    }

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(pid) = marker_pid(&path) else {
                continue;
            };
            if pid == std::process::id() || process_is_running(pid) {
                continue;
            }

            let previous = fs::read_to_string(&path).unwrap_or_else(|_| "unreadable".to_string());
            let _ = crate::debug_log::append_debug_log(&format!(
                "[backend:previous_exit] previous Dispatcher run ended without a clean exit marker={} details={}",
                path.display(),
                previous
            ));
            let _ = fs::remove_file(path);
        }
    }

    let path = dir.join(format!("{}{}.json", RUN_MARKER_PREFIX, std::process::id()));
    let content = serde_json::json!({
        "pid": std::process::id(),
        "startedUnixMs": unix_timestamp_millis().to_string(),
        "version": env!("CARGO_PKG_VERSION"),
        "debugBuild": cfg!(debug_assertions),
    })
    .to_string();

    match fs::write(&path, content) {
        Ok(()) => Some(RunMarker { path }),
        Err(err) => {
            let _ = crate::debug_log::append_debug_log(&format!(
                "[backend:run_state:error] failed to write run marker path={} error={}",
                path.display(),
                err
            ));
            None
        }
    }
}

pub fn mark_clean_exit(marker: Option<RunMarker>) {
    let Some(marker) = marker else {
        return;
    };
    match fs::remove_file(&marker.path) {
        Ok(()) => {
            let _ = crate::debug_log::append_debug_log(&format!(
                "[backend:run_state] clean exit pid={}",
                std::process::id()
            ));
        }
        Err(err) => {
            let _ = crate::debug_log::append_debug_log(&format!(
                "[backend:run_state:error] failed to remove run marker path={} error={}",
                marker.path.display(),
                err
            ));
        }
    }
}

#[cfg(target_os = "macos")]
pub fn log_legacy_webkit_storage_health() {
    use std::os::unix::fs::MetadataExt;

    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let root = PathBuf::from(home)
        .join("Library")
        .join("WebKit")
        .join("com.dispatcher.desktop")
        .join("WebsiteData");

    fn visit(path: &Path, depth: usize) {
        if depth > 8 {
            return;
        }
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                visit(&path, depth + 1);
                continue;
            }
            if path.file_name().and_then(|name| name.to_str()) != Some("localstorage.sqlite3-wal") {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let allocated_bytes = metadata.blocks().saturating_mul(512);
            if metadata.len() == 0 && allocated_bytes >= 128 * 1024 * 1024 {
                let _ = crate::debug_log::append_debug_log(&format!(
                    "[backend:startup:webkit_storage] legacy LocalStorage WAL is pathological logical_bytes=0 allocated_bytes={} path={} dedicated_data_store_enabled=true",
                    allocated_bytes,
                    path.display()
                ));
            }
        }
    }

    visit(&root, 0);
}

#[cfg(not(target_os = "macos"))]
pub fn log_legacy_webkit_storage_health() {}

#[cfg(test)]
mod tests {
    use super::marker_pid;
    use std::path::Path;

    #[test]
    fn extracts_pid_from_run_marker_name() {
        assert_eq!(
            marker_pid(Path::new("/tmp/dispatcher-running-1234.json")),
            Some(1234)
        );
        assert_eq!(
            marker_pid(Path::new("/tmp/dispatcher-running-x.json")),
            None
        );
        assert_eq!(marker_pid(Path::new("/tmp/something-1234.json")), None);
    }
}
