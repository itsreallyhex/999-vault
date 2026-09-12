//! 999, as a desktop app.
//!
//! The window is a webview over the same archive the site reads. What
//! Rust owns is everything the webview cannot do for itself: finding the
//! archive on disk, reading the two JSON indexes out of it, and running
//! the Python scripts.

mod data;
mod paths;
mod tools;

/// Build the app and run it. main.rs is a one-line wrapper around this.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Every path is resolved here rather than at compile time, so
            // this line is the first thing worth reading when the app
            // cannot find the archive on somebody else's machine.
            let handle = app.handle();
            let root = data::data_root(handle.clone());

            println!("999: config    {}", root.config_file);
            if root.exists {
                println!("999: archive   {}  (found by: {})", root.path, root.source);
                println!(
                    "999: contents  catalogue {}  covers {}  audio {}  index {}",
                    root.catalogue, root.covers, root.audio, root.audio_index
                );
            } else {
                println!("999: archive   not found. The Vault will ask the live archive.");
                println!("999:           set data_root in the config file above, or NINE_DATA_ROOT.");
            }

            match tools::tools_dir(&handle) {
                Some((dir, source)) => {
                    println!("999: tools     {}  (found by: {})", dir.to_string_lossy(), source)
                }
                None => println!("999: tools     not found. The Python scripts are unavailable."),
            }

            Ok(())
        })
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
