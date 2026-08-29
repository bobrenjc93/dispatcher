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

/// Bounce once more, replacing any bounce already in progress.
#[tauri::command]
pub fn pulse_dock_attention() -> Result<i64, PtyError> {
    Ok(imp::pulse())
}

/// Stop bouncing. Safe to call when nothing is bouncing.
#[tauri::command]
pub fn cancel_dock_attention() -> Result<(), PtyError> {
    imp::cancel();
    Ok(())
}
