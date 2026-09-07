//! Read-only detection of Tailscale, recorded in the diagnostic log.
//!
//! Why it matters: a phone talking to Dispatcher over plain HTTP is not a
//! secure context, so the clipboard API, service workers and web push are all
//! unavailable. The symptom is that copy and paste quietly do nothing, which
//! reads as Dispatcher being broken rather than as the page not being HTTPS.
//! `tailscale serve` fixes it by putting a real certificate in front of the
//! web server, and this records whether that is set up — so the log answers
//! the question instead of leaving it to guesswork.
//!
//! Detection only. Nothing here runs `tailscale serve`: that changes the
//! machine's tailnet configuration, and reconfiguring someone's network on
//! app launch is not a decision an app gets to make for them. The manual
//! command is in the README.

use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

/// Long enough for the CLI to reach a local daemon, short enough that a wedged
/// daemon cannot keep a probe alive for the life of the app.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Where the CLI lands when it is not on `PATH`.
///
/// A GUI app inherits launchd's environment rather than a shell's, so
/// `tailscale` working in your terminal says nothing about whether it is on
/// ours. The App Store build ships no `/usr/local/bin` symlink at all until
/// its "Install CLI" menu item is used, which is why the bundle path is here.
const CLI_CANDIDATES: &[&str] = &[
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/bin/tailscale",
    "/usr/sbin/tailscale",
    r"C:\Program Files\Tailscale\tailscale.exe",
];

#[derive(Deserialize)]
struct StatusJson {
    #[serde(rename = "BackendState", default)]
    backend_state: String,
    /// Empty when MagicDNS is off, in which case there is no name to serve on.
    #[serde(rename = "MagicDNSSuffix", default)]
    magic_dns_suffix: String,
    /// Non-empty once HTTPS certificates are enabled for the tailnet. Without
    /// them `tailscale serve` has no certificate to present.
    #[serde(rename = "CertDomains", default)]
    cert_domains: Vec<String>,
    #[serde(rename = "Self")]
    self_node: Option<SelfNode>,
}

#[derive(Deserialize)]
struct SelfNode {
    #[serde(rename = "DNSName", default)]
    dns_name: String,
}

#[derive(Deserialize)]
struct ServeStatusJson {
    #[serde(rename = "Web", default)]
    web: HashMap<String, ServeWebHost>,
}

#[derive(Deserialize)]
struct ServeWebHost {
    #[serde(rename = "Handlers", default)]
    handlers: HashMap<String, ServeHandler>,
}

#[derive(Deserialize)]
struct ServeHandler {
    #[serde(rename = "Proxy")]
    proxy: Option<String>,
}

/// Whether Serve is already pointing at the port we bound.
///
/// Distinguished from "pointing somewhere else" because they need different
/// advice: one is working, the other is a stale mapping to a port Dispatcher
/// no longer holds — which happens whenever 3003 was taken and the server
/// walked up to 3004.
#[derive(Debug, PartialEq, Eq)]
pub enum ServeState {
    /// Serve is proxying to this Dispatcher, with the URL it answers on.
    ProxyingUs(String),
    /// Serve is configured, but for other ports.
    ProxyingOther(Vec<u16>),
    /// No Serve configuration at all.
    Off,
}

/// The port a Serve proxy target points at, if it is one of ours.
///
/// Only loopback targets count. Serve can proxy anything reachable from this
/// machine, and another host's 3003 says nothing about whether this
/// Dispatcher is reachable.
fn loopback_proxy_port(target: &str) -> Option<u16> {
    let rest = target
        .strip_prefix("http://")
        .or_else(|| target.strip_prefix("https://"))
        .unwrap_or(target);
    let rest = rest.split('/').next()?;
    let (host, port) = rest.rsplit_once(':')?;
    if host != "127.0.0.1" && host != "localhost" && host != "[::1]" {
        return None;
    }
    port.parse().ok()
}

fn summarize_serve(status: &ServeStatusJson, our_port: u16) -> ServeState {
    let mut others = Vec::new();
    for (host, web) in &status.web {
        for handler in web.handlers.values() {
            let Some(port) = handler.proxy.as_deref().and_then(loopback_proxy_port) else {
                continue;
            };
            if port == our_port {
                // The host key carries the port Serve listens on, which is 443
                // for the HTTPS that makes any of this worth doing.
                let name = host.strip_suffix(":443").unwrap_or(host);
                return ServeState::ProxyingUs(format!("https://{name}"));
            }
            others.push(port);
        }
    }
    if others.is_empty() {
        ServeState::Off
    } else {
        others.sort_unstable();
        others.dedup();
        ServeState::ProxyingOther(others)
    }
}

fn find_cli() -> Option<PathBuf> {
    // `PATH` first: whatever the user installed most recently wins, the same
    // way it would in their shell.
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(if cfg!(windows) {
                "tailscale.exe"
            } else {
                "tailscale"
            });
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    CLI_CANDIDATES
        .iter()
        .map(PathBuf::from)
        .find(|candidate| candidate.is_file())
}

/// Run the CLI and return its stdout, or `None` if it failed or took too long.
async fn probe(cli: &PathBuf, args: &[&str]) -> Option<String> {
    let child = tokio::process::Command::new(cli)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;

    let output = match tokio::time::timeout(PROBE_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(_)) => return None,
        Err(_) => {
            // Dropped on timeout, and `kill_on_drop` reaps it.
            let _ = crate::debug_log::append_debug_log(&format!(
                "[backend:tailscale] probe timed out args={args:?}"
            ));
            return None;
        }
    };

    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Record what Tailscale can and cannot do for browser clients on `port`.
///
/// Best effort throughout: every failure is a log line, never an error the
/// user sees. Dispatcher works without Tailscale, just over plain HTTP.
pub fn log_detection(port: u16) {
    tauri::async_runtime::spawn(async move {
        let Some(cli) = find_cli() else {
            let _ = crate::debug_log::append_debug_log(
                "[backend:tailscale] cli not found; browsers reach Dispatcher over plain HTTP, \
                 so clipboard, service workers and web push stay unavailable",
            );
            return;
        };

        let Some(raw) = probe(&cli, &["status", "--json"]).await else {
            let _ = crate::debug_log::append_debug_log(&format!(
                "[backend:tailscale] cli={} but status failed; tailscaled is probably not running",
                cli.display()
            ));
            return;
        };

        let Ok(status) = serde_json::from_str::<StatusJson>(&raw) else {
            let _ = crate::debug_log::append_debug_log(
                "[backend:tailscale] could not parse status output",
            );
            return;
        };

        let serve = match probe(&cli, &["serve", "status", "--json"]).await {
            Some(raw) => serde_json::from_str::<ServeStatusJson>(&raw)
                .map(|parsed| summarize_serve(&parsed, port))
                .unwrap_or(ServeState::Off),
            // `serve status` exits non-zero when nothing is configured.
            None => ServeState::Off,
        };

        let name = status
            .self_node
            .as_ref()
            .map(|node| node.dns_name.trim_end_matches('.'))
            .unwrap_or("");

        let _ = crate::debug_log::append_debug_log(&format!(
            "[backend:tailscale] cli={} state={} magicDns={} https={} name={} port={} serve={}",
            cli.display(),
            if status.backend_state.is_empty() {
                "unknown"
            } else {
                &status.backend_state
            },
            !status.magic_dns_suffix.is_empty(),
            !status.cert_domains.is_empty(),
            if name.is_empty() { "none" } else { name },
            port,
            match &serve {
                ServeState::ProxyingUs(url) => format!("serving {url}"),
                ServeState::ProxyingOther(ports) =>
                    format!("configured for other ports {ports:?}, not {port}"),
                ServeState::Off => "off".to_string(),
            }
        ));

        if matches!(serve, ServeState::ProxyingUs(_)) {
            return;
        }

        // Say what is missing, in the order it has to be fixed. Each of these
        // is a prerequisite for the next, and a phone hitting a Serve URL
        // without them gets a certificate error rather than a clue.
        let blocker = if status.backend_state != "Running" {
            "tailscaled is not running"
        } else if status.magic_dns_suffix.is_empty() {
            "MagicDNS is off"
        } else if status.cert_domains.is_empty() {
            "HTTPS certificates are not enabled for this tailnet"
        } else {
            "nothing is proxying this port"
        };
        let _ = crate::debug_log::append_debug_log(&format!(
            "[backend:tailscale] not serving Dispatcher over HTTPS: {blocker}. \
             See the Tailscale section of the README; run `tailscale serve --bg {port}` to set it up"
        ));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_port_out_of_a_loopback_proxy_target() {
        assert_eq!(loopback_proxy_port("http://127.0.0.1:3003"), Some(3003));
        assert_eq!(loopback_proxy_port("http://localhost:3004/"), Some(3004));
        assert_eq!(loopback_proxy_port("http://[::1]:3003"), Some(3003));
    }

    #[test]
    fn ignores_proxy_targets_on_other_machines() {
        // Serve can proxy anything this machine can reach, and another host's
        // 3003 says nothing about whether this Dispatcher is reachable.
        assert_eq!(loopback_proxy_port("http://192.168.1.9:3003"), None);
        assert_eq!(loopback_proxy_port("http://127.0.0.1"), None);
    }

    fn serve_status(target: &str) -> ServeStatusJson {
        serde_json::from_str(&format!(
            r#"{{"Web":{{"host.tailnet.ts.net:443":{{"Handlers":{{"/":{{"Proxy":"{target}"}}}}}}}}}}"#
        ))
        .expect("fixture parses")
    }

    #[test]
    fn recognizes_serve_pointing_at_this_dispatcher() {
        assert_eq!(
            summarize_serve(&serve_status("http://127.0.0.1:3003"), 3003),
            ServeState::ProxyingUs("https://host.tailnet.ts.net".to_string())
        );
    }

    #[test]
    fn separates_a_stale_mapping_from_no_mapping() {
        // The port Dispatcher bound moves whenever 3003 is taken, so a Serve
        // config left pointing at 3003 is a different problem from Serve
        // never having been set up — and needs different advice.
        assert_eq!(
            summarize_serve(&serve_status("http://127.0.0.1:3003"), 3004),
            ServeState::ProxyingOther(vec![3003])
        );
        assert_eq!(
            summarize_serve(&ServeStatusJson { web: HashMap::new() }, 3003),
            ServeState::Off
        );
    }
}

