//! The WebKit process the page runs in.
//!
//! WKWebView runs the page in a separate WebContent process, and WebKit kills
//! that process outright once it passes its memory limit. The window is left
//! blank and the page's heartbeat simply stops, so the heartbeat watchdog only
//! reloaded it a minute later. Watching the process itself notices at once, and
//! its footprint is the number WebKit kills it on.

#[cfg(target_os = "macos")]
pub fn current_pid(app_handle: &tauri::AppHandle) -> Option<i32> {
    use objc::runtime::{Object, BOOL, YES};
    use objc::{msg_send, sel, sel_impl};
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::Manager;

    let window = app_handle.get_webview_window("main")?;
    let (sender, receiver) = mpsc::channel();
    window
        .with_webview(move |webview| {
            let view = webview.inner() as *mut Object;
            if view.is_null() {
                let _ = sender.send(0);
                return;
            }
            // Private, but long-standing; checked first so a WebKit without it
            // costs the diagnostics rather than an unrecognized-selector crash.
            let pid = unsafe {
                let responds: BOOL =
                    msg_send![view, respondsToSelector: sel!(_webProcessIdentifier)];
                if responds == YES {
                    let pid: i32 = msg_send![view, _webProcessIdentifier];
                    pid
                } else {
                    0
                }
            };
            let _ = sender.send(pid);
        })
        .ok()?;
    // The main thread may be busy; this tick can do without the answer.
    receiver.recv_timeout(Duration::from_secs(1)).ok()
}

#[cfg(not(target_os = "macos"))]
pub fn current_pid(_app_handle: &tauri::AppHandle) -> Option<i32> {
    None
}

#[cfg(unix)]
pub fn is_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
pub fn is_alive(_pid: i32) -> bool {
    false
}

/// The process's physical footprint: what Activity Monitor shows as Memory,
/// and what WebKit compares against its limit.
#[cfg(target_os = "macos")]
pub fn footprint_bytes(pid: i32) -> Option<u64> {
    let mut info: libc::rusage_info_v4 = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::proc_pid_rusage(
            pid,
            libc::RUSAGE_INFO_V4,
            &mut info as *mut libc::rusage_info_v4 as *mut libc::rusage_info_t,
        )
    };
    (result == 0).then_some(info.ri_phys_footprint)
}

#[cfg(not(target_os = "macos"))]
pub fn footprint_bytes(_pid: i32) -> Option<u64> {
    None
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn reads_a_live_process() {
        let pid = std::process::id() as i32;
        assert!(is_alive(pid));
        assert!(footprint_bytes(pid).unwrap_or(0) > 1024 * 1024);
        assert!(!is_alive(0));
    }
}
