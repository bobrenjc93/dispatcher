//! Serves Dispatcher to web browsers on port 3003 alongside the desktop window.
//!
//! The browser runs the exact same frontend bundle. What it lacks is Tauri's
//! IPC, so this module provides a WebSocket transport that speaks the same
//! shapes the frontend already uses: `invoke` requests and app events. The
//! frontend installs a matching shim (see `src/lib/webBridge.ts`), so nothing
//! above the transport needs to know which runtime it is in.
//!
//! A browser client is a *replica*: it renders what the desktop window mirrors
//! to it and sends user actions back for the desktop to perform. See
//! `replication.rs` for that half.

use crate::errors::PtyError;
use crate::replication::{self, ReplicationHub};
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, Request, State,
    },
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicU16, Ordering};
use tauri::{AppHandle, Listener, Manager};
use tokio::sync::mpsc;

pub const DEFAULT_WEB_PORT: u16 = 3003;

/// How many ports to walk before giving up when the preferred one is taken.
const PORT_SCAN_LIMIT: u16 = 32;

/// Upper bound on a proxied dev-server request body.
const MAX_PROXY_BODY_BYTES: usize = 32 * 1024 * 1024;

/// Events a replica needs. Everything else — terminal exits, font panel
/// changes, PTY plumbing — is the desktop window's business.
const FORWARDED_EVENTS: [&str; 3] = [
    replication::APP_STATE_EVENT,
    replication::MIRROR_EVENT,
    replication::ACTION_EVENT,
];

/// Commands a replica is allowed to call. A replica never touches the PTY or
/// tmux layer, so the surface is deliberately tiny: read the workspace, publish
/// edits to it, send actions to the desktop, and write diagnostics.
const REPLICA_COMMANDS: [&str; 8] = [
    "read_shared_app_state",
    "read_app_state_backup",
    "write_app_state_backup",
    "get_app_state_backup_path",
    "get_primary_client",
    "relay_action",
    "append_debug_log",
    "get_web_server_info",
];

// ---------------------------------------------------------------------------
// Server info
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebServerInfo {
    pub enabled: bool,
    pub port: u16,
    pub urls: Vec<String>,
}

/// Best-effort primary LAN address. Connecting a UDP socket sends no packets;
/// it just asks the routing table which interface would be used.
fn primary_lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(203, 0, 113, 1), 80)).ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_loopback()).then_some(ip)
}

pub fn info(app_handle: &AppHandle) -> WebServerInfo {
    let port = app_handle.state::<WebServerPort>().get();
    if port == 0 {
        // Still binding, or no port was free.
        return WebServerInfo {
            enabled: false,
            port: 0,
            urls: Vec::new(),
        };
    }

    let mut urls = vec![format!("http://localhost:{port}")];
    if let Some(ip) = primary_lan_ip() {
        urls.push(format!("http://{ip}:{port}"));
    }
    WebServerInfo {
        enabled: true,
        port,
        urls,
    }
}

/// The port actually bound, which may not be the preferred one. Zero until the
/// listener is up.
pub struct WebServerPort(AtomicU16);

impl WebServerPort {
    pub fn get(&self) -> u16 {
        self.0.load(Ordering::Relaxed)
    }
}

/// Take the first free port at or above `preferred`. Another Dispatcher, or any
/// other process, may already hold it.
async fn bind_available_port(preferred: u16) -> Option<(tokio::net::TcpListener, u16)> {
    for offset in 0..PORT_SCAN_LIMIT {
        let Some(port) = preferred.checked_add(offset) else {
            break;
        };

        let addr = SocketAddr::from((Ipv4Addr::UNSPECIFIED, port));
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                if offset > 0 {
                    let _ = crate::debug_log::append_debug_log(&format!(
                        "[backend:web_server] port {} unavailable, using {} instead",
                        preferred, port
                    ));
                }
                return Some((listener, port));
            }
            Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(err) => {
                let _ = crate::debug_log::append_debug_log(&format!(
                    "[backend:web_server:error] failed to bind addr={} error={}",
                    addr, err
                ));
                return None;
            }
        }
    }

    let _ = crate::debug_log::append_debug_log(&format!(
        "[backend:web_server:error] no free port in {}..{}",
        preferred,
        preferred.saturating_add(PORT_SCAN_LIMIT)
    ));
    None
}

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ClientMessage {
    #[serde(rename_all = "camelCase")]
    Invoke {
        id: u64,
        cmd: String,
        #[serde(default)]
        args: Value,
    },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ServerMessage {
    #[serde(rename_all = "camelCase")]
    Ready { client_id: String },
    #[serde(rename_all = "camelCase")]
    Response {
        id: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Event { event: String, payload: Value },
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct ServerState {
    app_handle: AppHandle,
    http: reqwest::Client,
}

pub fn start(app_handle: AppHandle, preferred_port: u16) {
    app_handle.manage(WebServerPort(AtomicU16::new(0)));

    let state = ServerState {
        app_handle: app_handle.clone(),
        http: reqwest::Client::new(),
    };

    tauri::async_runtime::spawn(async move {
        let router = Router::new()
            .route("/dispatcher-ws", get(websocket_handler))
            .fallback(get(asset_handler))
            .with_state(state.clone());

        let Some((listener, port)) = bind_available_port(preferred_port).await else {
            return;
        };
        state
            .app_handle
            .state::<WebServerPort>()
            .0
            .store(port, Ordering::Relaxed);

        let _ = crate::debug_log::append_debug_log(&format!(
            "[backend:web_server] listening port={} preferred={} dev={}",
            port,
            preferred_port,
            tauri::is_dev()
        ));

        if let Err(err) = axum::serve(listener, router).await {
            let _ = crate::debug_log::append_debug_log(&format!(
                "[backend:web_server:error] server stopped error={}",
                err
            ));
        }
    });
}

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

/// Where `tauri dev` runs Vite. Always contacted over loopback: this process
/// and the dev server are on the same machine.
fn dev_server_base(app_handle: &AppHandle) -> String {
    app_handle
        .config()
        .build
        .dev_url
        .as_ref()
        .map(|url| url.to_string())
        .unwrap_or_else(|| "http://localhost:1420/".to_string())
        .trim_end_matches('/')
        .to_string()
}

/// Under `tauri dev` the app is served by Vite rather than embedded in the
/// binary. Proxy it instead of redirecting: a redirect would send the browser
/// to *its own* localhost, which is meaningless on a phone reaching this
/// machine over Tailscale or the LAN. Proxying keeps everything — page, assets
/// and the IPC socket — on this one port in both dev and release builds.
async fn proxy_to_dev_server(state: &ServerState, request: Request) -> Response {
    let path_and_query = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str().to_owned())
        .unwrap_or_else(|| "/".to_string());
    let url = format!("{}{}", dev_server_base(&state.app_handle), path_and_query);

    let (parts, body) = request.into_parts();
    let body_bytes = match axum::body::to_bytes(body, MAX_PROXY_BODY_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => return (StatusCode::BAD_REQUEST, "request body too large").into_response(),
    };

    let mut outgoing = state.http.request(parts.method, &url);
    for (name, value) in parts.headers.iter() {
        // Host must reflect the dev server, and hop-by-hop headers are ours.
        if name == header::HOST || name == header::CONNECTION {
            continue;
        }
        outgoing = outgoing.header(name, value);
    }

    let upstream = match outgoing.body(body_bytes).send().await {
        Ok(response) => response,
        Err(err) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("Dispatcher dev server is not reachable at {url}: {err}"),
            )
                .into_response();
        }
    };

    let status = upstream.status();
    let headers = upstream.headers().clone();
    let bytes = match upstream.bytes().await {
        Ok(bytes) => bytes,
        Err(err) => return (StatusCode::BAD_GATEWAY, err.to_string()).into_response(),
    };

    let mut response = Response::builder().status(status);
    for (name, value) in headers.iter() {
        if name == header::TRANSFER_ENCODING || name == header::CONNECTION {
            continue;
        }
        response = response.header(name, value);
    }
    response
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

/// Serves the same bundle the desktop window loads.
async fn asset_handler(State(state): State<ServerState>, request: Request) -> Response {
    if tauri::is_dev() {
        return proxy_to_dev_server(&state, request).await;
    }

    let resolver = state.app_handle.asset_resolver();

    // Unknown paths fall back to index.html so the app can boot from any URL.
    let asset = resolver
        .get(request.uri().path().to_string())
        .or_else(|| resolver.get("/index.html".to_string()));

    match asset {
        Some(asset) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, asset.mime_type.clone())],
            Body::from(asset.bytes),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

// ---------------------------------------------------------------------------
// WebSocket bridge
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct WebSocketQuery {
    #[serde(rename = "clientId")]
    client_id: Option<String>,
}

async fn websocket_handler(
    ws: WebSocketUpgrade,
    State(state): State<ServerState>,
    Query(query): Query<WebSocketQuery>,
) -> Response {
    let client_id = query
        .client_id
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| format!("web-{}", uuid::Uuid::new_v4()));

    ws.on_upgrade(move |socket| handle_socket(socket, state, client_id))
}

async fn handle_socket(socket: WebSocket, state: ServerState, client_id: String) {
    let (mut sender, mut receiver) = socket.split();
    // Everything outbound funnels through this queue so event emitters never
    // block on a slow socket.
    let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<String>();

    state
        .app_handle
        .state::<ReplicationHub>()
        .replica_connected(&state.app_handle);
    let _ = crate::debug_log::append_debug_log(&format!(
        "[backend:web_server] replica connected client_id={}",
        client_id
    ));

    let send_task = tokio::spawn(async move {
        while let Some(text) = outbound_rx.recv().await {
            if sender.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    if let Ok(text) = serde_json::to_string(&ServerMessage::Ready {
        client_id: client_id.clone(),
    }) {
        let _ = outbound_tx.send(text);
    }

    let event_ids = subscribe_events(&state.app_handle, &outbound_tx);

    while let Some(Ok(message)) = receiver.next().await {
        let text = match message {
            Message::Text(text) => text.to_string(),
            Message::Close(_) => break,
            _ => continue,
        };

        let Ok(ClientMessage::Invoke { id, cmd, args }) = serde_json::from_str(&text) else {
            continue;
        };

        let response = match dispatch(&state.app_handle, &client_id, &cmd, args) {
            Ok(value) => ServerMessage::Response {
                id,
                ok: true,
                value: Some(value),
                error: None,
            },
            Err(err) => ServerMessage::Response {
                id,
                ok: false,
                value: None,
                error: Some(err),
            },
        };

        if let Ok(text) = serde_json::to_string(&response) {
            if outbound_tx.send(text).is_err() {
                break;
            }
        }
    }

    for event_id in event_ids {
        state.app_handle.unlisten(event_id);
    }
    drop(outbound_tx);
    send_task.abort();

    state
        .app_handle
        .state::<ReplicationHub>()
        .replica_disconnected(&state.app_handle);
    let _ = crate::debug_log::append_debug_log(&format!(
        "[backend:web_server] replica disconnected client_id={}",
        client_id
    ));
}

fn subscribe_events(
    app_handle: &AppHandle,
    outbound_tx: &mpsc::UnboundedSender<String>,
) -> Vec<tauri::EventId> {
    FORWARDED_EVENTS
        .iter()
        .map(|event_name| {
            let outbound_tx = outbound_tx.clone();
            let event_name = (*event_name).to_string();
            app_handle.listen_any(event_name.clone(), move |event| {
                let payload: Value = serde_json::from_str(event.payload()).unwrap_or(Value::Null);
                if let Ok(text) = serde_json::to_string(&ServerMessage::Event {
                    event: event_name.clone(),
                    payload,
                }) {
                    let _ = outbound_tx.send(text);
                }
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("missing string argument `{key}`"))
}

fn arg_opt_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(ToOwned::to_owned)
}

fn to_json<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|err| err.to_string())
}

fn err_message(err: PtyError) -> String {
    err.message
}

fn dispatch(
    app_handle: &AppHandle,
    client_id: &str,
    cmd: &str,
    args: Value,
) -> Result<Value, String> {
    if !REPLICA_COMMANDS.contains(&cmd) {
        // Anything outside the replica surface would mean a browser reaching
        // straight for a PTY or tmux, bypassing the desktop window.
        return Err(format!("`{cmd}` is not available to a browser replica"));
    }

    match cmd {
        "read_shared_app_state" => replication::read_shared_app_state(app_handle.clone())
            .map_err(err_message)
            .and_then(to_json),
        "read_app_state_backup" => crate::commands::read_app_state_backup(
            app_handle.clone(),
            arg_opt_str(&args, "storageNamespace"),
        )
        .map_err(err_message)
        .and_then(to_json),
        "write_app_state_backup" => crate::commands::write_app_state_backup(
            app_handle.clone(),
            arg_str(&args, "content")?,
            arg_opt_str(&args, "storageNamespace"),
            Some(client_id.to_string()),
        )
        .map_err(err_message)
        .and_then(to_json),
        "get_app_state_backup_path" => crate::commands::get_app_state_backup_path(
            app_handle.clone(),
            arg_opt_str(&args, "storageNamespace"),
        )
        .map_err(err_message)
        .and_then(to_json),
        "get_primary_client" => replication::get_primary_client(app_handle.clone())
            .map_err(err_message)
            .and_then(to_json),
        "relay_action" => replication::relay_action(
            app_handle.clone(),
            args.get("action").cloned().unwrap_or(Value::Null),
            Some(client_id.to_string()),
        )
        .map(|_| Value::Null)
        .map_err(err_message),
        "append_debug_log" => crate::debug_log::append_debug_log(&arg_str(&args, "message")?)
            .map(|_| Value::Null)
            .map_err(err_message),
        "get_web_server_info" => to_json(info(app_handle)),
        other => Err(format!("unknown command `{other}`")),
    }
}
