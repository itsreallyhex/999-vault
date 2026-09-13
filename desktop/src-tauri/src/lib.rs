//! 999, as a desktop app.
//!
//! The window is a webview over the same archive the site reads. What
//! Rust owns is everything the webview cannot do for itself: finding the
//! archive on disk, reading the two JSON indexes out of it, serving the
//! pages themselves off disk, running the Python scripts, saving one
//! track into the archive, and talking to Discord's local pipe.

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

mod data;
mod download;
mod files;
mod pages;
mod paths;
mod presence;
mod settings;
mod tools;
mod watch;

/// Build the app and run it. main.rs is a one-line wrapper around this.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(presence::Presence::default())
        // The pages are read from a folder, not from the binary. See
        // pages.rs for why, and for the rules that find the folder.
        .register_uri_scheme_protocol(pages::SCHEME, pages::serve)
        .setup(|app| {
            // Resolved once, before the window asks for shell.html
            app.manage(pages::resolve(app.handle()));
            // Every path is resolved here rather than at compile time, so
            // this line is the first thing worth reading when the app
            // cannot find the archive on somebody else's machine.
            let handle = app.handle();
            let root = data::data_root(handle.clone());

            println!("999: config    {}", root.config_file);
            {
                let pages = app.state::<pages::Pages>();
                match &pages.dir {
                    Some(dir) => println!("999: pages     {}  (found by: {})", dir.to_string_lossy(), pages.source),
                    None => println!("999: pages     not found. Set pages_dir in the config file, or NINE_PAGES_DIR."),
                }
                // An edit to a page reloads the window on its own, when
                // the pages are the kind that get edited.
                println!("999: watch     {}", watch::start(handle, &pages));
            }
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

            println!("999: discord   {}", presence::describe(&handle));
            println!("999: source    {} first", settings::source(&handle));

            // The window is made here, not declared in tauri.conf.json.
            // A declared window resolves its page against devUrl in a
            // dev build and against frontendDist in a release build,
            // and the first of those is unset, so `tauri dev` went to
            // the embedded assets, of which there are none. A custom
            // protocol URL given outright resolves the same way in both,
            // and wry rewrites it to http://nine.localhost on Windows.
            let url = tauri::Url::parse("nine://localhost/shell.html").expect("a fixed url parses");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::CustomProtocol(url))
                .title("999")
                .inner_size(1280.0, 820.0)
                .min_inner_size(940.0, 620.0)
                .resizable(true)
                .theme(Some(tauri::Theme::Dark))
                .background_color(tauri::webview::Color(8, 7, 12, 255))
                .build()?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            data::data_root,
            data::read_catalogue,
            data::read_audio_index,
            download::download_track,
            files::save_text,
            tools::tools_status,
            tools::run_tool,
            presence::presence_set,
            presence::presence_clear,
            presence::presence_info,
            settings::settings_get,
            settings::settings_set,
            settings::pick_folder,
        ])
        .run(tauri::generate_context!())
        .expect("999 failed to start");
}
