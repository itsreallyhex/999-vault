//! 999, as a desktop app.
//!
//! The window is a webview over the same archive the site reads. What
//! Rust owns is everything the webview cannot do for itself: finding the
//! archive on disk, reading the two JSON indexes out of it, and running
//! the Python scripts.

mod data;
mod tools;

/// Build the app and run it. main.rs is a one-line wrapper around this.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let root = data::data_root();
    println!("999: archive root {} ({})", root.path, root.source);
    if !root.exists {
        println!("999: that folder is not there. The Vault will fall back to the live archive.");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            data::data_root,
            data::read_catalogue,
            data::read_audio_index,
            tools::tools_status,
            tools::run_tool,
        ])
        .run(tauri::generate_context!())
        .expect("999 failed to start");
}
