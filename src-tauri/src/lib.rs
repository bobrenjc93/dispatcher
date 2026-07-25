mod commands;
mod debug_log;
mod errors;
#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs)]
mod font_panel;
mod pty_manager;
mod renderer_watchdog;

use pty_manager::PtyManager;
use renderer_watchdog::RendererWatchdog;
use std::panic;
use std::sync::Once;
use tauri::{Manager, WindowEvent};

static PANIC_HOOK: Once = Once::new();

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
    install_panic_hook();
    let renderer_watchdog = RendererWatchdog::new();
    let watchdog_for_setup = renderer_watchdog.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .manage(PtyManager::new())
        .manage(renderer_watchdog)
        .on_window_event(|window, event| {
            log_window_event(window.label(), event);
        })
        .setup(move |app| {
            let _ = debug_log::init_debug_log();
            watchdog_for_setup.start();
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
            commands::append_debug_log,
            commands::renderer_heartbeat,
            commands::get_debug_log_path,
            commands::write_debug_artifact,
            commands::read_app_state_backup,
            commands::write_app_state_backup,
            commands::get_app_state_backup_path,
            commands::show_font_panel,
            commands::hide_font_panel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
