//! Saving a file the page has built.
//!
//! The playlists page exports its lists as JSON. On the site that is a
//! blob URL on an `<a download>`, which a browser turns into a download;
//! the webview does not, it drops the click without a word, which is how
//! the owner found the button "doesn't work". So on the desktop the page
//! hands the text to Rust, a native Save As dialog asks where, and the
//! file is written here. Import needs nothing: an `<input type="file">`
//! opens the native picker in WebView2 and reads back fine.

use tauri::AppHandle;

/// Ask where to save `text` under a suggested `name`, write it there,
/// and answer the path. None means the dialog was cancelled. The dialog
/// blocks, so this is async and the dialog runs off the main thread,
/// the way `pick_folder` in settings.rs does.
#[tauri::command]
pub async fn save_text(_app: AppHandle, name: String, text: String) -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title("Save as")
            .set_file_name(&name)
            .add_filter("JSON", &["json"])
            .save_file()
    })
    .await
    .map_err(|err| format!("dialog thread failed: {}", err))?;

    let Some(path) = picked else { return Ok(None) };

    std::fs::write(&path, text)
        .map_err(|err| format!("{}: {}", path.to_string_lossy(), err))?;

    Ok(Some(path.to_string_lossy().replace('\\', "/")))
}
