#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The same binary is the app and the terminal daemon; the app re-executes
    // itself with this flag when no daemon is running. Checked before Tauri
    // starts so the daemon never builds a window.
    if std::env::args().any(|arg| arg == dispatcher_lib::daemon::DAEMON_ARG) {
        if let Err(err) = dispatcher_lib::daemon::run_daemon() {
            eprintln!("dispatcher daemon failed: {}", err);
            std::process::exit(1);
        }
        return;
    }

    dispatcher_lib::run();
}
