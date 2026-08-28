//! Message bus between the desktop window and its browser replicas.
//!
//! Dispatcher's desktop window is the master: it is the only client that owns
//! PTYs, drives tmux, and decides what a terminal looks like. A browser is a
//! replica — it renders what the master mirrors to it, and anything the user
//! does there is sent to the master to perform.
//!
//! This module is deliberately dumb. It does not interpret actions or terminal
//! frames; it just routes three kinds of message:
//!
//! - **app state** — the workspace document (projects, tabs, splits, notes)
//! - **mirror** — master → replicas: terminal output and grid sizes
//! - **action** — replica → master: something the user did, for the master to do

use crate::errors::PtyError;
use serde::Serialize;
use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Master → replicas: rendered terminal output and sizes.
pub const MIRROR_EVENT: &str = "dispatcher-mirror";
/// Replica → master: a user action for the master to perform.
pub const ACTION_EVENT: &str = "dispatcher-action";
/// The workspace document changed.
pub const APP_STATE_EVENT: &str = "app-state-changed";
/// How many replicas are watching, so the master can skip mirroring when none are.
pub const REPLICAS_EVENT: &str = "dispatcher-replicas";

#[derive(Default)]
pub struct ReplicationHub {
    latest_app_state: Mutex<Option<String>>,
    primary_client_id: Mutex<Option<String>>,
    replica_count: Mutex<usize>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStateChangedPayload {
    content: String,
    origin_client_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionPayload {
    action: Value,
    origin_client_id: Option<String>,
}

impl ReplicationHub {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn latest_app_state(&self) -> Option<String> {
        self.latest_app_state.lock().unwrap().clone()
    }

    pub fn primary_client_id(&self) -> Option<String> {
        self.primary_client_id.lock().unwrap().clone()
    }

    pub fn replica_count(&self) -> usize {
        *self.replica_count.lock().unwrap()
    }

    pub fn replica_connected(&self, app_handle: &AppHandle) {
        let count = {
            let mut guard = self.replica_count.lock().unwrap();
            *guard += 1;
            *guard
        };
        let _ = app_handle.emit(REPLICAS_EVENT, count);
    }

    pub fn replica_disconnected(&self, app_handle: &AppHandle) {
        let count = {
            let mut guard = self.replica_count.lock().unwrap();
            *guard = guard.saturating_sub(1);
            *guard
        };
        let _ = app_handle.emit(REPLICAS_EVENT, count);
    }

    pub fn publish_app_state(
        &self,
        app_handle: &AppHandle,
        content: String,
        origin_client_id: Option<&str>,
    ) {
        {
            let mut latest = self.latest_app_state.lock().unwrap();
            if latest.as_deref() == Some(content.as_str()) {
                return;
            }
            *latest = Some(content.clone());
        }

        let _ = app_handle.emit(
            APP_STATE_EVENT,
            AppStateChangedPayload {
                content,
                origin_client_id: origin_client_id.map(ToOwned::to_owned),
            },
        );
    }
}

/// The desktop window claims mastery at startup. Replicas use this to confirm
/// there is somebody to send their actions to.
#[tauri::command]
pub fn set_primary_client(app_handle: AppHandle, client_id: String) -> Result<(), PtyError> {
    let hub = app_handle.state::<ReplicationHub>();
    *hub.primary_client_id.lock().unwrap() = Some(client_id.clone());
    let _ = crate::debug_log::append_debug_log(&format!(
        "[backend:replication] primary client registered client_id={}",
        client_id
    ));
    Ok(())
}

#[tauri::command]
pub fn get_primary_client(app_handle: AppHandle) -> Result<Option<String>, PtyError> {
    Ok(app_handle.state::<ReplicationHub>().primary_client_id())
}

#[tauri::command]
pub fn get_replica_count(app_handle: AppHandle) -> Result<usize, PtyError> {
    Ok(app_handle.state::<ReplicationHub>().replica_count())
}

/// Replica → master. The master performs the action in its own context, which
/// is what keeps PTY writes and tmux commands coming from a single client.
#[tauri::command]
pub fn relay_action(
    app_handle: AppHandle,
    action: Value,
    client_id: Option<String>,
) -> Result<(), PtyError> {
    app_handle
        .emit(
            ACTION_EVENT,
            ActionPayload {
                action,
                origin_client_id: client_id,
            },
        )
        .map_err(|err| PtyError::from(err.to_string()))
}

/// Master → replicas. Carries terminal output and grid sizes as an opaque
/// payload; the shape is owned by the frontend.
#[tauri::command]
pub fn publish_mirror(app_handle: AppHandle, payload: Value) -> Result<(), PtyError> {
    app_handle
        .emit(MIRROR_EVENT, payload)
        .map_err(|err| PtyError::from(err.to_string()))
}

/// The newest workspace document any client published this run, so a replica
/// starts from what the master is currently showing.
#[tauri::command]
pub fn read_shared_app_state(app_handle: AppHandle) -> Result<Option<String>, PtyError> {
    Ok(app_handle.state::<ReplicationHub>().latest_app_state())
}

#[tauri::command]
pub fn get_web_server_info(
    app_handle: AppHandle,
) -> Result<crate::web_server::WebServerInfo, PtyError> {
    Ok(crate::web_server::info(&app_handle))
}
