//! Tauri implementations of the PTY layer's host and output sink.
//!
//! These are the desktop-process side of the seam in `pty_manager`: the
//! recorder reached through Tauri state, terminal exits emitted as window
//! events, and output delivered over an IPC `Channel`. The daemon supplies its
//! own implementations of the same two traits over a socket.

use crate::pty_manager::{OutputSink, PtyHost, TerminalExitPayload, TerminalOutput};
use tauri::{ipc::Channel, AppHandle, Emitter, Manager};

pub struct TauriPtyHost {
    app_handle: AppHandle,
}

impl TauriPtyHost {
    pub fn new(app_handle: AppHandle) -> Self {
        TauriPtyHost { app_handle }
    }

    fn recorder(&self) -> tauri::State<'_, crate::session_recorder::SessionRecorder> {
        self.app_handle
            .state::<crate::session_recorder::SessionRecorder>()
    }
}

impl PtyHost for TauriPtyHost {
    fn record_output(&self, terminal_id: &str, data: &str) {
        self.recorder().record_transport_output(terminal_id, data);
    }

    fn record_input(&self, terminal_id: &str, data: &str) {
        self.recorder().record_transport_input(terminal_id, data);
    }

    fn record_event(&self, name: &str, payload: serde_json::Value) {
        self.recorder().record_event(name, payload);
    }

    fn terminal_exited(&self, terminal_id: &str, exit_code: Option<i32>) {
        let _ = self.app_handle.emit(
            "terminal-exit",
            TerminalExitPayload {
                terminal_id: terminal_id.to_owned(),
                exit_code,
            },
        );
    }
}

/// Delivers output over the Tauri IPC channel the frontend opened.
pub struct ChannelSink {
    channel: Channel<TerminalOutput>,
}

impl ChannelSink {
    pub fn new(channel: Channel<TerminalOutput>) -> Self {
        ChannelSink { channel }
    }
}

impl OutputSink for ChannelSink {
    fn send(&self, terminal_id: &str, data: &str) -> bool {
        self.channel
            .send(TerminalOutput {
                terminal_id: terminal_id.to_owned(),
                data: data.to_owned(),
            })
            .is_ok()
    }
}
