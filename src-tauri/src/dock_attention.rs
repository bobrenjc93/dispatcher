//! Bouncing the dock icon until the user actually looks.
//!
//! Tauri's own `request_user_attention` cannot do this. It maps `Critical` to
//! `NSCriticalRequest` correctly, but its cancel path is a no-op — it never
//! calls `cancelUserAttentionRequest` — so an outstanding request can never be
//! cleared, and asking again while one is pending is coalesced by macOS into
//! nothing. The result is a single bounce and then silence.
//!
//! Talking to `NSApplication` directly gives both halves: a request id to hold
//! on to, and a real cancel, so each pulse can retire the previous request and
//! start a fresh bounce.

use crate::errors::PtyError;
use std::sync::mpsc;
use std::time::Duration;
use tauri::AppHandle;

/// `NSCriticalRequest` — bounces until the app is activated or the request is
/// cancelled, as opposed to `NSInformationalRequest`, which bounces once.
#[cfg(target_os = "macos")]
const NS_CRITICAL_REQUEST: i64 = 0;

#[cfg(target_os = "macos")]
mod imp {
    use super::NS_CRITICAL_REQUEST;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    use std::sync::Mutex;

    /// The outstanding request, so it can be retired before the next one.
    static REQUEST: Mutex<Option<i64>> = Mutex::new(None);

    fn cancel_locked(current: &mut Option<i64>) {
        let Some(id) = current.take() else {
            return;
        };
        unsafe {
            let app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
            let _: () = msg_send![app, cancelUserAttentionRequest: id];
        }
    }

    /// Retire any pending request and start a new bounce. Returns the request
    /// id, which is only useful for confirming one was actually registered.
    pub fn pulse() -> i64 {
        let mut current = REQUEST.lock().unwrap();
        cancel_locked(&mut current);
        let id: i64 = unsafe {
            let app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
            msg_send![app, requestUserAttention: NS_CRITICAL_REQUEST]
        };
        *current = Some(id);
        id
    }

    pub fn cancel() {
        let mut current = REQUEST.lock().unwrap();
        cancel_locked(&mut current);
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn pulse() -> i64 {
        0
    }
    pub fn cancel() {}
}

/// AppKit is main-thread only, and a Tauri command runs on a worker thread.
/// Messaging `NSApplication` from the wrong thread does not fail loudly — it
/// returns a nonsense request id (-1) and no bounce ever happens.
fn on_main_thread<T: Send + 'static>(
    app_handle: &AppHandle,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, PtyError> {
    let (tx, rx) = mpsc::channel();
    app_handle
        .run_on_main_thread(move || {
            let _ = tx.send(work());
        })
        .map_err(|err| PtyError::from(err.to_string()))?;
    rx.recv_timeout(Duration::from_secs(2))
        .map_err(|err| PtyError::from(err.to_string()))
}

/// Bounce once more, replacing any bounce already in progress. The returned
/// request id is negative when macOS refused the request.
#[tauri::command]
pub fn pulse_dock_attention(app_handle: AppHandle) -> Result<i64, PtyError> {
    on_main_thread(&app_handle, imp::pulse)
}

/// Stop bouncing. Safe to call when nothing is bouncing.
#[tauri::command]
pub fn cancel_dock_attention(app_handle: AppHandle) -> Result<(), PtyError> {
    on_main_thread(&app_handle, imp::cancel)
}
