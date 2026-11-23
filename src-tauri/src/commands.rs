use crate::errors::PtyError;
use crate::pty_manager::{PtyManager, TerminalDebugInfo, TerminalOutput};
use crate::renderer_watchdog::{RendererHeartbeatDetails, RendererWatchdog};
use crate::replication::ReplicationHub;
use std::fs;
use std::path::Path;
use std::time::SystemTime;
#[allow(unused_imports)]
use tauri::{ipc::Channel, AppHandle, Manager, State};

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

/// Run a terminal command off the main thread.
///
/// Tauri runs a plain command on the main thread, and these wait on the
/// terminal daemon -- for up to 20 seconds when it does not answer -- which
/// froze the whole window with it, every time it was opened onto a daemon in
/// that state. Writes and resizes stay where they are: they have to reach the
/// daemon in the order they were made, and they are sent without waiting for
/// an answer.
async fn off_main_thread<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, PtyError> + Send + 'static,
) -> Result<T, PtyError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|err| PtyError::from(err.to_string()))?
}

#[tauri::command]
pub async fn create_terminal(
    app_handle: AppHandle,
    terminal_id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_output: Channel<TerminalOutput>,
) -> Result<(), PtyError> {
    off_main_thread(move || create_terminal_blocking(app_handle, terminal_id, cwd, cols, rows, on_output)).await
}

fn create_terminal_blocking(
    app_handle: AppHandle,
    terminal_id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_output: Channel<TerminalOutput>,
) -> Result<(), PtyError> {
    let state = app_handle.state::<PtyManager>();
    let _ = crate::debug_log::append_debug_log(&format!(
        "[backend:create_terminal] terminal_id={} cwd={:?} cols={} rows={}",
        terminal_id, cwd, cols, rows
    ));

    let result = match &*app_handle.state::<crate::daemon_client::TerminalBackend>() {
        crate::daemon_client::TerminalBackend::Daemon(client) => {
            client.create_terminal(terminal_id.clone(), cwd, cols, rows, on_output)
        }
        crate::daemon_client::TerminalBackend::InProcess => state.create_terminal(
            terminal_id.clone(),
            cwd,
            cols,
            rows,
            Box::new(crate::tauri_host::ChannelSink::new(on_output)),
        ),
    };
    if let Err(err) = &result {
        let _ = crate::debug_log::append_debug_log(&format!(
            "[backend:create_terminal:error] terminal_id={} error={}",
            terminal_id, err.message
        ));
    }
    result
}

#[tauri::command]
pub fn write_terminal(
    app_handle: AppHandle,
    state: State<'_, PtyManager>,
    terminal_id: String,
    data: String,
) -> Result<(), PtyError> {
    let _ = crate::debug_log::append_debug_log(&format!(
        "[backend:write_terminal] terminal_id={} bytes={} preview={}",
        terminal_id,
        data.len(),
        preview_terminal_data(&data, 120)
    ));

    let result = match &*app_handle.state::<crate::daemon_client::TerminalBackend>() {
        crate::daemon_client::TerminalBackend::Daemon(client) => client.write_terminal(&terminal_id, &data),
        crate::daemon_client::TerminalBackend::InProcess => state.write_terminal(&terminal_id, data.as_bytes()),
    };
    if let Err(err) = &result {
        let _ = crate::debug_log::append_debug_log(&format!(
            "[backend:write_terminal:error] terminal_id={} error={}",
            terminal_id, err.message
        ));
    }
    result
}

#[tauri::command]
pub fn resize_terminal(
    app_handle: AppHandle,
    state: State<'_, PtyManager>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), PtyError> {
    let _ = crate::debug_log::append_debug_log(&format!(
        "[backend:resize_terminal] terminal_id={} cols={} rows={}",
        terminal_id, cols, rows
    ));

    let result = match &*app_handle.state::<crate::daemon_client::TerminalBackend>() {
        crate::daemon_client::TerminalBackend::Daemon(client) => client.resize_terminal(&terminal_id, cols, rows),
        crate::daemon_client::TerminalBackend::InProcess => state.resize_terminal(&terminal_id, cols, rows),
    };
    if let Err(err) = &result {
        let _ = crate::debug_log::append_debug_log(&format!(
            "[backend:resize_terminal:error] terminal_id={} error={}",
            terminal_id, err.message
        ));
    }
    result
}

#[tauri::command]
pub async fn close_terminal(app_handle: AppHandle, terminal_id: String) -> Result<(), PtyError> {
    off_main_thread(move || close_terminal_blocking(app_handle, terminal_id)).await
}

fn close_terminal_blocking(app_handle: AppHandle, terminal_id: String) -> Result<(), PtyError> {
    let state = app_handle.state::<PtyManager>();
    let _ = crate::debug_log::append_debug_log(&format!(
        "[backend:close_terminal] terminal_id={}",
        terminal_id
    ));

    let result = match &*app_handle.state::<crate::daemon_client::TerminalBackend>() {
        crate::daemon_client::TerminalBackend::Daemon(client) => client.close_terminal(&terminal_id),
        crate::daemon_client::TerminalBackend::InProcess => state.close_terminal(&terminal_id),
    };
    if let Err(err) = &result {
        let _ = crate::debug_log::append_debug_log(&format!(
            "[backend:close_terminal:error] terminal_id={} error={}",
            terminal_id, err.message
        ));
    }
    result
}

#[tauri::command]
pub async fn get_terminal_cwd(
    app_handle: AppHandle,
    terminal_id: String,
) -> Result<Option<String>, PtyError> {
    off_main_thread(move || get_terminal_cwd_blocking(app_handle, terminal_id)).await
}

fn get_terminal_cwd_blocking(
    app_handle: AppHandle,
    terminal_id: String,
) -> Result<Option<String>, PtyError> {
    let state = app_handle.state::<PtyManager>();
    let result = match &*app_handle.state::<crate::daemon_client::TerminalBackend>() {
        crate::daemon_client::TerminalBackend::Daemon(client) => client.get_terminal_cwd(&terminal_id),
        crate::daemon_client::TerminalBackend::InProcess => state.get_terminal_cwd(&terminal_id),
    };
    match &result {
        Ok(cwd) => {
            let _ = crate::debug_log::append_debug_log(&format!(
                "[backend:get_terminal_cwd] terminal_id={} cwd={:?}",
                terminal_id, cwd
            ));
        }
        Err(err) => {
            let _ = crate::debug_log::append_debug_log(&format!(
                "[backend:get_terminal_cwd:error] terminal_id={} error={}",
                terminal_id, err.message
            ));
        }
    }
    result
}

/// Terminals whose PTY is still running in this process. After a reload the UI
/// uses this to reattach to what survived instead of respawning it.
#[tauri::command]
pub async fn list_live_terminals(app_handle: AppHandle) -> Result<Vec<String>, PtyError> {
    off_main_thread(move || {
        match &*app_handle.state::<crate::daemon_client::TerminalBackend>() {
            crate::daemon_client::TerminalBackend::Daemon(client) => client.live_terminal_ids(),
            crate::daemon_client::TerminalBackend::InProcess => {
                Ok(app_handle.state::<PtyManager>().live_terminal_ids())
            }
        }
    })
    .await
}

#[tauri::command]
pub async fn get_terminal_debug_info(
    app_handle: AppHandle,
    terminal_id: String,
) -> Result<TerminalDebugInfo, PtyError> {
    off_main_thread(move || {
        match &*app_handle.state::<crate::daemon_client::TerminalBackend>() {
            crate::daemon_client::TerminalBackend::Daemon(client) => client.get_terminal_debug_info(&terminal_id),
            crate::daemon_client::TerminalBackend::InProcess => {
                app_handle.state::<PtyManager>().get_terminal_debug_info(&terminal_id)
            }
        }
    })
    .await
}

#[tauri::command]
pub async fn warm_pool(app_handle: AppHandle, count: usize) -> Result<(), PtyError> {
    off_main_thread(move || {
        match &*app_handle.state::<crate::daemon_client::TerminalBackend>() {
            crate::daemon_client::TerminalBackend::Daemon(client) => client.warm_pool(count),
            crate::daemon_client::TerminalBackend::InProcess => app_handle.state::<PtyManager>().warm_pool(count),
        }
    })
    .await
}

#[tauri::command]
pub async fn refresh_pool(app_handle: AppHandle) -> Result<(), PtyError> {
    off_main_thread(move || {
        match &*app_handle.state::<crate::daemon_client::TerminalBackend>() {
            crate::daemon_client::TerminalBackend::Daemon(client) => client.refresh_pool(),
            crate::daemon_client::TerminalBackend::InProcess => app_handle.state::<PtyManager>().refresh_pool(),
        }
    })
    .await
}

#[tauri::command]
pub fn append_debug_log(message: String) -> Result<(), PtyError> {
    crate::debug_log::append_debug_log(&message)
}

#[tauri::command]
pub fn renderer_heartbeat(
    state: State<'_, RendererWatchdog>,
    details: RendererHeartbeatDetails,
) -> Result<(), PtyError> {
    state.record_heartbeat(details)
}

#[tauri::command]
pub fn get_debug_log_path() -> Result<String, PtyError> {
    Ok(crate::debug_log::debug_log_path().display().to_string())
}

fn sanitize_debug_artifact_name(file_name: &str) -> String {
    let sanitized: String = file_name
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '-' | '_' => ch,
            _ => '_',
        })
        .collect();

    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        "artifact.txt".to_string()
    } else {
        sanitized
    }
}

const DEBUG_ARTIFACT_MAX_FILES: usize = 400;
const DEBUG_ARTIFACT_MAX_BYTES: u64 = 300 * 1024 * 1024;

struct DebugArtifactEntry {
    path: std::path::PathBuf,
    modified: SystemTime,
    bytes: u64,
}

fn prune_debug_artifacts(dir: &Path) -> Result<(), PtyError> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if metadata.is_file() {
            entries.push(DebugArtifactEntry {
                path: entry.path(),
                modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                bytes: metadata.len(),
            });
        }
    }

    entries.sort_by(|a, b| b.modified.cmp(&a.modified));

    let mut kept_files = 0usize;
    let mut kept_bytes = 0u64;
    let mut removed_files = 0usize;
    let mut removed_bytes = 0u64;
    for entry in entries {
        kept_files += 1;
        kept_bytes = kept_bytes.saturating_add(entry.bytes);
        if kept_files <= DEBUG_ARTIFACT_MAX_FILES && kept_bytes <= DEBUG_ARTIFACT_MAX_BYTES {
            continue;
        }

        fs::remove_file(&entry.path)?;
        removed_files += 1;
        removed_bytes = removed_bytes.saturating_add(entry.bytes);
    }

    if removed_files > 0 {
        let _ = crate::debug_log::append_debug_log(&format!(
            "[backend:debug_artifacts:prune] removed_files={} removed_bytes={} max_files={} max_bytes={}",
            removed_files, removed_bytes, DEBUG_ARTIFACT_MAX_FILES, DEBUG_ARTIFACT_MAX_BYTES
        ));
    }

    Ok(())
}

#[tauri::command]
pub fn write_debug_artifact(file_name: String, content: String) -> Result<String, PtyError> {
    let debug_log_path = crate::debug_log::debug_log_path();
    let dir = debug_log_path
        .parent()
        .map(|parent| parent.join("dispatcher-debug-artifacts"))
        .unwrap_or_else(|| std::env::temp_dir().join("dispatcher-debug-artifacts"));
    fs::create_dir_all(&dir)?;

    let path = dir.join(sanitize_debug_artifact_name(&file_name));
    fs::write(&path, content)?;
    let _ = prune_debug_artifacts(&dir);

    Ok(path.display().to_string())
}

fn app_state_backup_file_name(storage_namespace: Option<&str>) -> String {
    let Some(namespace) = storage_namespace else {
        return "dispatcher-state-backup.json".to_string();
    };

    // Keep the namespace path-safe because this value comes from the frontend.
    // None/empty remains production's historical filename for compatibility.
    let sanitized: String = namespace
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect();

    if sanitized.is_empty() {
        "dispatcher-state-backup.json".to_string()
    } else {
        format!("dispatcher-state-backup.{}.json", sanitized)
    }
}

fn app_state_backup_path(
    app_handle: &AppHandle,
    storage_namespace: Option<&str>,
) -> Result<std::path::PathBuf, PtyError> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|err| PtyError::from(err.to_string()))?;
    Ok(dir.join(app_state_backup_file_name(storage_namespace)))
}

const APP_STATE_BACKUP_GENERATIONS: usize = 10;

fn app_state_backup_generation_path(
    path: &std::path::Path,
    generation: usize,
) -> std::path::PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("dispatcher-state-backup.json");
    path.with_file_name(format!("{}.{}", file_name, generation))
}

fn rotate_existing_app_state_backups(path: &std::path::Path) -> Result<(), PtyError> {
    if !path.exists() {
        return Ok(());
    }

    // Keep a short local history because the frontend writes state after every
    // tab-tree mutation. If a bad shortcut or renderer bug removes many tabs,
    // the current backup can become bad before anyone has time to inspect it.
    let oldest = app_state_backup_generation_path(path, APP_STATE_BACKUP_GENERATIONS);
    match fs::remove_file(&oldest) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(PtyError::from(err)),
    }

    for generation in (1..APP_STATE_BACKUP_GENERATIONS).rev() {
        let from = app_state_backup_generation_path(path, generation);
        let to = app_state_backup_generation_path(path, generation + 1);
        match fs::rename(&from, &to) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(PtyError::from(err)),
        }
    }

    fs::copy(path, app_state_backup_generation_path(path, 1))?;
    Ok(())
}

/// How many hourly and daily snapshots of the workspace to keep.
const APP_STATE_HOURLY_SNAPSHOTS: usize = 72;
const APP_STATE_DAILY_SNAPSHOTS: usize = 30;

/// Keep snapshots of the workspace an hour and a day apart.
///
/// The generations above are a minute deep at best, because every change
/// rotates them. When tabs went missing over a night of reloads, all ten were
/// copies of the already-damaged workspace, and nothing older existed to put
/// back. One snapshot per hour for three days, and one per day for a month,
/// costs a few megabytes and means a loss can be undone.
///
/// Best effort: a snapshot that cannot be written is not a reason to fail the
/// save it rides on.
fn snapshot_app_state_history(path: &std::path::Path, content: &str, now_secs: u64) {
    let Some(dir) = path.parent().map(|parent| parent.join("history")) else {
        return;
    };
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    for (kind, bucket_secs, keep) in [
        ("hourly", 3_600u64, APP_STATE_HOURLY_SNAPSHOTS),
        ("daily", 86_400u64, APP_STATE_DAILY_SNAPSHOTS),
    ] {
        let prefix = format!("{}.{}-", file_name, kind);
        let snapshot = dir.join(format!("{}{}.json", prefix, now_secs / bucket_secs));
        if !snapshot.exists() {
            let _ = fs::write(&snapshot, content);
        }
        prune_app_state_history(&dir, &prefix, keep);
    }
}

fn prune_app_state_history(dir: &std::path::Path, prefix: &str, keep: usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut buckets: Vec<(u64, std::path::PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let bucket = name.strip_prefix(prefix)?.strip_suffix(".json")?.parse().ok()?;
            Some((bucket, entry.path()))
        })
        .collect();
    buckets.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, stale) in buckets.into_iter().skip(keep) {
        let _ = fs::remove_file(stale);
    }
}

#[tauri::command]
pub fn read_app_state_backup(
    app_handle: AppHandle,
    storage_namespace: Option<String>,
) -> Result<Option<String>, PtyError> {
    let path = app_state_backup_path(&app_handle, storage_namespace.as_deref())?;
    match fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(PtyError::from(err)),
    }
}

#[tauri::command]
pub fn write_app_state_backup(
    app_handle: AppHandle,
    content: String,
    storage_namespace: Option<String>,
    client_id: Option<String>,
) -> Result<String, PtyError> {
    let path = app_state_backup_path(&app_handle, storage_namespace.as_deref())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    rotate_existing_app_state_backups(&path)?;

    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, &content)?;
    fs::rename(&tmp_path, &path)?;
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    snapshot_app_state_history(&path, &content, now_secs);

    // Every client persists the same document shape, so the write doubles as
    // the sync point: hand it to the replicas so their tabs, layout and notes
    // follow the desktop window.
    app_handle
        .state::<ReplicationHub>()
        .publish_app_state(&app_handle, content, client_id.as_deref());

    Ok(path.display().to_string())
}

#[tauri::command]
pub fn get_app_state_backup_path(
    app_handle: AppHandle,
    storage_namespace: Option<String>,
) -> Result<String, PtyError> {
    Ok(app_state_backup_path(&app_handle, storage_namespace.as_deref())?
        .display()
        .to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn keeps_one_snapshot_per_hour_and_day_and_prunes_old_ones() {
        let dir = std::env::temp_dir().join(format!(
            "dispatcher-history-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("dispatcher-state-backup.dev.json");
        let history = dir.join("history");

        // Two writes in one hour keep the first; a write each hour for longer
        // than the window keeps only the newest.
        super::snapshot_app_state_history(&path, "first", 3_600 * 10);
        super::snapshot_app_state_history(&path, "second", 3_600 * 10 + 60);
        let first_hour = history.join("dispatcher-state-backup.dev.json.hourly-10.json");
        assert_eq!(std::fs::read_to_string(&first_hour).unwrap(), "first");

        for hour in 11..(11 + super::APP_STATE_HOURLY_SNAPSHOTS as u64 + 5) {
            super::snapshot_app_state_history(&path, "later", 3_600 * hour);
        }
        let hourly = std::fs::read_dir(&history)
            .unwrap()
            .filter(|entry| {
                entry.as_ref().unwrap().file_name().to_string_lossy().contains(".hourly-")
            })
            .count();
        assert_eq!(hourly, super::APP_STATE_HOURLY_SNAPSHOTS);
        assert!(!first_hour.exists());
        assert!(history.join("dispatcher-state-backup.dev.json.daily-0.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    use super::app_state_backup_file_name;

    #[test]
    fn app_state_backup_file_name_keeps_prod_name_stable() {
        assert_eq!(app_state_backup_file_name(None), "dispatcher-state-backup.json");
        assert_eq!(
            app_state_backup_file_name(Some("")),
            "dispatcher-state-backup.json"
        );
    }

    #[test]
    fn app_state_backup_file_name_namespaces_dev() {
        assert_eq!(
            app_state_backup_file_name(Some("dev")),
            "dispatcher-state-backup.dev.json"
        );
    }

    #[test]
    fn app_state_backup_file_name_sanitizes_namespace() {
        assert_eq!(
            app_state_backup_file_name(Some("dev/../../prod")),
            "dispatcher-state-backup.devprod.json"
        );
    }
}

#[tauri::command]
pub fn show_font_panel(
    app_handle: AppHandle,
    family: String,
    size: f64,
    weight: String,
) -> Result<(), PtyError> {
    #[cfg(target_os = "macos")]
    {
        crate::font_panel::show(app_handle, &family, size, &weight)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app_handle, family, size, weight);
    }
    Ok(())
}

#[tauri::command]
pub fn hide_font_panel() -> Result<(), PtyError> {
    #[cfg(target_os = "macos")]
    {
        crate::font_panel::hide()?;
    }
    Ok(())
}

