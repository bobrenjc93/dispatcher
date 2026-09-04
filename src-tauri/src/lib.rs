mod commands;
pub mod daemon;
mod daemon_client;
mod debug_log;
mod dock_attention;
mod errors;
#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs)]
mod font_panel;
mod pty_manager;
mod tauri_host;
mod renderer_watchdog;
mod replication;
mod run_diagnostics;
mod session_recorder;
mod web_push;
mod web_server;

use pty_manager::PtyManager;
use renderer_watchdog::RendererWatchdog;
use replication::ReplicationHub;
use session_recorder::SessionRecorder;
use web_server::DEFAULT_WEB_PORT;
use std::panic;
use std::sync::Once;
use std::time::Instant;
use tauri::{Manager, WindowEvent};

static PANIC_HOOK: Once = Once::new();

#[cfg(target_os = "macos")]
const DISPATCHER_DATA_STORE_IDENTIFIER: [u8; 16] = [
    81, 113, 6, 145, 246, 121, 79, 193, 178, 169, 111, 133, 42, 119, 21, 54,
];

fn install_panic_hook() {
    PANIC_HOOK.call_once(|| {
        let default_hook = panic::take_hook();
        panic::set_hook(Box::new(move |panic_info| {
            let location = panic_info
                .location()
                .map(|location| {
                    format!(
                        "{}:{}:{}",
                        location.file(),
                        location.line(),
                        location.column()
                    )
                })
                .unwrap_or_else(|| "unknown".to_string());
            let payload = panic_info
                .payload()
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| {
                    panic_info
                        .payload()
                        .downcast_ref::<String>()
                        .map(String::as_str)
                })
                .unwrap_or("non-string panic payload");
            let _ = debug_log::append_debug_log(&format!(
                "[backend:panic] thread={:?} location={} payload={}",
                std::thread::current().name(),
                location,
                payload
            ));
            default_hook(panic_info);
        }));
    });
}

fn log_window_event(label: &str, event: &WindowEvent) {
    let message = match event {
        WindowEvent::CloseRequested { .. } => Some("close_requested".to_string()),
        WindowEvent::Destroyed => Some("destroyed".to_string()),
        WindowEvent::Focused(focused) => Some(format!("focused focused={}", focused)),
        WindowEvent::ScaleFactorChanged {
            scale_factor,
            new_inner_size,
            ..
        } => Some(format!(
            "scale_factor_changed scale_factor={} width={} height={}",
            scale_factor, new_inner_size.width, new_inner_size.height
        )),
        WindowEvent::ThemeChanged(theme) => Some(format!("theme_changed theme={:?}", theme)),
        _ => None,
    };

    if let Some(message) = message {
        let _ = debug_log::append_debug_log(&format!(
            "[backend:window_event] label={} {} pid={}",
            label,
            message,
            std::process::id()
        ));
    }
}

pub fn run() {
    let process_started_at = Instant::now();
    install_panic_hook();
    let _ = debug_log::init_debug_log();
    let run_marker = run_diagnostics::mark_run_started();
    run_diagnostics::log_legacy_webkit_storage_health();
    let _ = debug_log::append_debug_log(&format!(
        "[backend:startup] process started pid={} version={} debug_build={} log_path={}",
        std::process::id(),
        env!("CARGO_PKG_VERSION"),
        cfg!(debug_assertions),
        debug_log::debug_log_path().display()
    ));

    let renderer_watchdog = RendererWatchdog::new();
    let watchdog_for_setup = renderer_watchdog.clone();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .manage(PtyManager::new())
        .manage(ReplicationHub::new())
        .manage(SessionRecorder::new())
        .manage(renderer_watchdog)
        .on_page_load(move |webview, payload| {
            let _ = debug_log::append_debug_log(&format!(
                "[backend:startup] page_load event={:?} label={} url={} elapsed_ms={}",
                payload.event(),
                webview.label(),
                payload.url(),
                process_started_at.elapsed().as_millis()
            ));
        })
        .on_window_event(|window, event| {
            log_window_event(window.label(), event);
        })
        .setup(move |app| {
            let _ = debug_log::init_debug_log();
            // The PTY layer is constructed before a handle exists, so give it
            // its host now that one does.
            app.state::<PtyManager>()
                .set_host(std::sync::Arc::new(tauri_host::TauriPtyHost::new(
                    app.handle().clone(),
                )));
            // Terminals live in the daemon so they outlive this process. Falls
            // back to the in-process manager if the daemon cannot be reached.
            let backend = daemon_client::TerminalBackend::connect(app.handle());
            let _ = debug_log::append_debug_log(&format!(
                "[backend:startup] terminal backend={}",
                if backend.is_daemon() { "daemon" } else { "in-process" }
            ));
            app.manage(backend);
            let window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|config| config.label == "main")
                .cloned()
                .ok_or_else(|| std::io::Error::other("main window config is missing"))?;
            let window_builder =
                tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?;
            #[cfg(target_os = "macos")]
            let window_builder =
                window_builder.data_store_identifier(DISPATCHER_DATA_STORE_IDENTIFIER);
            window_builder.build()?;

            watchdog_for_setup.start(app.handle().clone());

            // Serve the same app to web browsers. Browsers run as replicas of
            // this window: they render what it mirrors and send user actions
            // back for it to perform.
            let web_port = std::env::var("DISPATCHER_WEB_PORT")
                .ok()
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(DEFAULT_WEB_PORT);
            web_server::start(app.handle().clone(), web_port);

            let window_labels = app
                .webview_windows()
                .keys()
                .cloned()
                .collect::<Vec<_>>()
                .join(",");
            let _ = debug_log::append_debug_log(&format!(
                "[backend] tauri setup complete pid={} windows={}",
                std::process::id(),
                window_labels
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_terminal,
            commands::write_terminal,
            commands::resize_terminal,
            commands::close_terminal,
            commands::warm_pool,
            commands::refresh_pool,
            commands::get_terminal_cwd,
            commands::get_terminal_debug_info,
            commands::list_live_terminals,
            commands::append_debug_log,
            commands::renderer_heartbeat,
            commands::get_debug_log_path,
            commands::write_debug_artifact,
            commands::read_app_state_backup,
            commands::write_app_state_backup,
            commands::get_app_state_backup_path,
            replication::set_primary_client,
            replication::get_primary_client,
            replication::get_replica_count,
            replication::relay_action,
            replication::publish_mirror,
            replication::read_shared_app_state,
            replication::get_web_server_info,
            web_push::send_web_push,
            session_recorder::record_pane_output,
            session_recorder::record_session_event,
            session_recorder::describe_recorded_terminal,
            session_recorder::get_recording_info,
            session_recorder::set_recording_enabled,
            dock_attention::pulse_dock_attention,
            dock_attention::cancel_dock_attention,
            commands::show_font_panel,
            commands::hide_font_panel,
        ]);

    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(err) => {
            let _ = debug_log::append_debug_log(&format!(
                "[backend:fatal] failed to build tauri application error={}",
                err
            ));
            panic!("error while building tauri application: {err}");
        }
    };

    let mut run_marker = run_marker;
    app.run(move |_app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            run_diagnostics::mark_clean_exit(run_marker.take());
        }
    });
}
