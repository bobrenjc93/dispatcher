mod commands;
mod errors;
#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs)]
mod font_panel;
mod pty_manager;

use pty_manager::PtyManager;

pub fn run() {
    tauri::Builder::default()
        .manage(PtyManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::create_terminal,
            commands::write_terminal,
            commands::resize_terminal,
            commands::close_terminal,
            commands::warm_pool,
            commands::refresh_pool,
            commands::get_terminal_cwd,
            commands::show_font_panel,
            commands::hide_font_panel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
