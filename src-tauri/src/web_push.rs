//! Delivering an already-encrypted Web Push message.
//!
//! Only the HTTP request lives here. The VAPID signature and the RFC 8291
//! payload encryption are done in the renderer, which already holds the keys
//! and the logic deciding a tab needs attention, and whose Web Crypto is
//! verified against the RFC's own test vector.
//!
//! What the renderer cannot do is send it. A push service exists to be called
//! by servers, so it has no reason to opt into CORS — Apple's returns no
//! `Access-Control-*` headers at all — and a browser `fetch` carrying
//! `Authorization`, `TTL` and `Content-Encoding` triggers a preflight that
//! fails before the request is ever made. From here there is no such rule.

use serde::Serialize;
use std::time::Duration;

/// Push services are not part of the user's workflow; a slow one must not tie
/// up a request slot indefinitely, and the next attention event will try again.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Serialize)]
pub struct WebPushResponse {
    /// HTTP status, or 0 when the request never completed.
    pub status: u16,
    /// Body text, truncated: these are short JSON errors when present at all.
    pub detail: String,
}

/// POST an encrypted push message to a subscription endpoint.
///
/// Transport failures come back as `status: 0` rather than as an error, so the
/// caller can treat "could not reach the service" and "the service said no"
/// with the same code path — only 404 and 410 mean anything actionable, and
/// both are real statuses.
#[tauri::command]
pub async fn send_web_push(
    endpoint: String,
    authorization: String,
    ttl_seconds: u32,
    body: Vec<u8>,
) -> WebPushResponse {
    let client = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
        Ok(client) => client,
        Err(err) => {
            return WebPushResponse {
                status: 0,
                detail: format!("building http client: {err}"),
            }
        }
    };

    let result = client
        .post(&endpoint)
        .header("Authorization", authorization)
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .header("TTL", ttl_seconds.to_string())
        .body(body)
        .send()
        .await;

    match result {
        Ok(response) => {
            let status = response.status().as_u16();
            let detail = response
                .text()
                .await
                .unwrap_or_default()
                .chars()
                .take(300)
                .collect();
            WebPushResponse { status, detail }
        }
        Err(err) => WebPushResponse {
            status: 0,
            detail: err.to_string(),
        },
    }
}
