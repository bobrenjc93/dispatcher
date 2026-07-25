use crate::errors::PtyError;
use serde::Deserialize;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};

const WATCHDOG_CHECK_INTERVAL: Duration = Duration::from_secs(5);
const HEARTBEAT_STALE_AFTER_MS: u128 = 15_000;
const HEARTBEAT_STALE_LOG_INTERVAL_MS: u128 = 30_000;
const HEARTBEAT_ALIVE_LOG_INTERVAL_MS: u128 = 60_000;
const NO_HEARTBEAT_LOG_AFTER_MS: u128 = 30_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererHeartbeatDetails {
    pub sequence: u64,
    pub reason: String,
    pub href: Option<String>,
    pub visibility_state: Option<String>,
    pub active_terminal_id: Option<String>,
    pub active_terminal_backend_kind: Option<String>,
    pub session_count: usize,
    pub local_count: usize,
    pub tmux_transport_count: usize,
    pub tmux_window_count: usize,
    pub tmux_pane_count: usize,
    pub skipped_heartbeat_count: usize,
}

#[derive(Clone)]
pub struct RendererWatchdog {
    state: Arc<Mutex<RendererWatchdogState>>,
}

struct RendererWatchdogState {
    started_at: SystemTime,
    last_heartbeat_at: Option<SystemTime>,
    last_sequence: Option<u64>,
    last_details: Option<RendererHeartbeatDetails>,
    last_alive_log_at: Option<SystemTime>,
    last_stale_log_at: Option<SystemTime>,
    stale_logged: bool,
    no_heartbeat_logged: bool,
}

impl RendererHeartbeatDetails {
    fn summary(&self) -> String {
        format!(
            "reason={} visibility={} active={} active_backend={} sessions={} local={} tmux_transport={} tmux_window={} tmux_pane={} skipped={} href={}",
            sanitize_log_value(&self.reason, 80),
            sanitize_log_value(self.visibility_state.as_deref().unwrap_or("unknown"), 40),
            sanitize_log_value(self.active_terminal_id.as_deref().unwrap_or("none"), 120),
            sanitize_log_value(self.active_terminal_backend_kind.as_deref().unwrap_or("unknown"), 40),
            self.session_count,
            self.local_count,
            self.tmux_transport_count,
            self.tmux_window_count,
            self.tmux_pane_count,
            self.skipped_heartbeat_count,
            sanitize_log_value(self.href.as_deref().unwrap_or("unknown"), 160)
        )
    }
}

impl RendererWatchdog {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(RendererWatchdogState {
                started_at: SystemTime::now(),
                last_heartbeat_at: None,
                last_sequence: None,
                last_details: None,
                last_alive_log_at: None,
                last_stale_log_at: None,
                stale_logged: false,
                no_heartbeat_logged: false,
            })),
        }
    }

    pub fn start(&self) {
        let state = Arc::clone(&self.state);
        let result = thread::Builder::new()
            .name("dispatcher-renderer-watchdog".to_string())
            .spawn(move || loop {
                thread::sleep(WATCHDOG_CHECK_INTERVAL);

                let log_message = match state.lock() {
                    Ok(mut guard) => guard.check_for_stale_heartbeat(),
                    Err(_) => Some(
                        "[backend:renderer_watchdog:error] heartbeat state lock poisoned; watchdog stopped"
                            .to_string(),
                    ),
                };

                if let Some(message) = log_message {
                    let should_stop = message.contains("watchdog stopped");
                    let _ = crate::debug_log::append_debug_log(&message);
                    if should_stop {
                        break;
                    }
                }
            });

        if let Err(err) = result {
            let _ = crate::debug_log::append_debug_log(&format!(
                "[backend:renderer_watchdog:error] failed to start watchdog thread error={}",
                err
            ));
        }
    }

    pub fn record_heartbeat(&self, details: RendererHeartbeatDetails) -> Result<(), PtyError> {
        let log_message = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| PtyError::from(String::from("renderer watchdog lock poisoned")))?;
            state.record_heartbeat(details)
        };

        if let Some(message) = log_message {
            crate::debug_log::append_debug_log(&message)?;
        }

        Ok(())
    }
}

impl RendererWatchdogState {
    fn record_heartbeat(&mut self, details: RendererHeartbeatDetails) -> Option<String> {
        let now = SystemTime::now();
        let sequence = details.sequence;
        let details_summary = details.summary();

        let log_message = if let Some(last_heartbeat_at) = self.last_heartbeat_at {
            if self.stale_logged {
                Some(format!(
                    "[backend:renderer_watchdog] renderer heartbeat recovered stale_ms={} sequence={} {} pid={}",
                    elapsed_millis_since(now, last_heartbeat_at),
                    sequence,
                    details_summary,
                    std::process::id()
                ))
            } else if self
                .last_alive_log_at
                .map(|last_log_at| {
                    elapsed_millis_since(now, last_log_at) >= HEARTBEAT_ALIVE_LOG_INTERVAL_MS
                })
                .unwrap_or(true)
            {
                Some(format!(
                    "[backend:renderer_heartbeat] renderer alive sequence={} {} pid={}",
                    sequence,
                    details_summary,
                    std::process::id()
                ))
            } else {
                None
            }
        } else {
            Some(format!(
                "[backend:renderer_heartbeat] first renderer heartbeat sequence={} {} pid={}",
                sequence,
                details_summary,
                std::process::id()
            ))
        };

        self.last_heartbeat_at = Some(now);
        self.last_sequence = Some(sequence);
        self.last_details = Some(details);
        if log_message.is_some() {
            self.last_alive_log_at = Some(now);
        }
        self.stale_logged = false;
        self.last_stale_log_at = None;
        self.no_heartbeat_logged = false;

        log_message
    }

    fn check_for_stale_heartbeat(&mut self) -> Option<String> {
        let now = SystemTime::now();

        let Some(last_heartbeat_at) = self.last_heartbeat_at else {
            if !self.no_heartbeat_logged
                && elapsed_millis_since(now, self.started_at) >= NO_HEARTBEAT_LOG_AFTER_MS
            {
                self.no_heartbeat_logged = true;
                return Some(format!(
                    "[backend:renderer_watchdog] no renderer heartbeat received startup_age_ms={} pid={}",
                    elapsed_millis_since(now, self.started_at),
                    std::process::id()
                ));
            }
            return None;
        };

        let stale_ms = elapsed_millis_since(now, last_heartbeat_at);
        if stale_ms < HEARTBEAT_STALE_AFTER_MS {
            return None;
        }

        let should_log = !self.stale_logged
            || self
                .last_stale_log_at
                .map(|last_log_at| {
                    elapsed_millis_since(now, last_log_at) >= HEARTBEAT_STALE_LOG_INTERVAL_MS
                })
                .unwrap_or(true);

        if !should_log {
            return None;
        }

        self.stale_logged = true;
        self.last_stale_log_at = Some(now);

        // This watchdog must remain diagnostic-only. Reloading the webview
        // destroys renderer-owned routing for live PTYs, including tmux -CC
        // transports running over SSH.
        Some(format!(
            "[backend:renderer_watchdog] renderer heartbeat stale stale_ms={} last_sequence={} last_details=\"{}\" pid={}",
            stale_ms,
            self.last_sequence
                .map(|sequence| sequence.to_string())
                .unwrap_or_else(|| "none".to_string()),
            self.last_details
                .as_ref()
                .map(RendererHeartbeatDetails::summary)
                .unwrap_or_else(|| "none".to_string()),
            std::process::id()
        ))
    }
}

fn elapsed_millis_since(now: SystemTime, earlier: SystemTime) -> u128 {
    now.duration_since(earlier).unwrap_or_default().as_millis()
}

fn sanitize_log_value(value: &str, limit: usize) -> String {
    let mut result = String::new();
    let mut count = 0usize;

    for ch in value.chars() {
        if count >= limit {
            result.push_str("...");
            break;
        }

        match ch {
            '\n' => result.push_str("\\n"),
            '\r' => result.push_str("\\r"),
            '\t' => result.push_str("\\t"),
            '"' => result.push_str("\\\""),
            c if c.is_control() => result.push_str(&format!("\\x{:02x}", c as u32)),
            c => result.push(c),
        }
        count += 1;
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heartbeat_details(sequence: u64) -> RendererHeartbeatDetails {
        RendererHeartbeatDetails {
            sequence,
            reason: "test".to_string(),
            href: Some("dispatcher://test".to_string()),
            visibility_state: Some("visible".to_string()),
            active_terminal_id: Some("terminal-1".to_string()),
            active_terminal_backend_kind: Some("tmux".to_string()),
            session_count: 1,
            local_count: 0,
            tmux_transport_count: 1,
            tmux_window_count: 1,
            tmux_pane_count: 1,
            skipped_heartbeat_count: 0,
        }
    }

    fn watchdog_state(last_heartbeat_age: Duration) -> RendererWatchdogState {
        let now = SystemTime::now();
        RendererWatchdogState {
            started_at: now - Duration::from_secs(60),
            last_heartbeat_at: Some(now - last_heartbeat_age),
            last_sequence: Some(42),
            last_details: Some(heartbeat_details(42)),
            last_alive_log_at: None,
            last_stale_log_at: None,
            stale_logged: false,
            no_heartbeat_logged: false,
        }
    }

    #[test]
    fn stale_heartbeat_is_logged() {
        let mut state = watchdog_state(Duration::from_secs(20));

        let result = state.check_for_stale_heartbeat();

        assert!(result.is_some());
        assert!(state.stale_logged);
    }

    #[test]
    fn very_stale_heartbeat_remains_diagnostic_only() {
        let mut state = watchdog_state(Duration::from_secs(5 * 60));

        let result = state.check_for_stale_heartbeat();
        let message = result.expect("very stale heartbeat should be logged");

        assert!(message.contains("renderer heartbeat stale"));
        assert!(message.contains("last_sequence=42"));
        assert!(message.contains("active=terminal-1"));
    }
}
