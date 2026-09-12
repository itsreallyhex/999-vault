//! The settings a person changes inside the app.
//!
//! They live in the same config.toml data.rs writes on first run, next
//! to data_root and the rest, so there is one file and one place to
//! look. The difference is who edits it: those keys were for a text
//! editor, these are for the Settings page. Writes go through
//! toml_edit so the comments in the file survive; the plain `toml`
//! crate would flatten them on the way back out.
//!
//! Two keys so far:
//!
//!   source   "local" plays the file on disk and streams only when
//!            there is none (the default). "stream" plays from the
//!            archive and falls back to the file if the archive fails.
//!   discord  false turns Rich Presence off. presence_set refuses
//!            while it is off, so nothing reaches the pipe.
//!
//! data_root can be set from here too, through the folder picker,
//! which is the same key data.rs reads. A missing key means the
//! default, so a config written before this existed needs nothing.

use serde::Serialize;
use tauri::AppHandle;
use toml_edit::DocumentMut;

use crate::data;

const SOURCE_KEY: &str = "source";
const DISCORD_KEY: &str = "discord";
const ROOT_KEY: &str = "data_root";

/// What the Settings page draws.
#[derive(Serialize, Clone, Debug)]
pub struct Settings {
    /// "local" or "stream".
    pub source: String,
    pub discord: bool,
    /// The archive as resolved right now, with which rule found it.
    pub data_root: data::DataRoot,
    /// What data_root in the file says, empty if unset. Shown so the
    /// person can tell a folder they chose from one the app found.
    pub data_root_setting: String,
    pub config_file: String,
}

/// The config file parsed for editing, or an empty document if it is
/// unreadable. Never fails: a broken file gets its keys rewritten.
fn document(app: &AppHandle) -> (Option<std::path::PathBuf>, DocumentMut) {
    let file = data::config_file(app);
    let doc = file
        .as_ref()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|text| text.parse::<DocumentMut>().ok())
        .unwrap_or_default();
    (file, doc)
}

/// "stream" if the file says so, otherwise "local".
pub fn source(app: &AppHandle) -> String {
    match data::config_str(app, SOURCE_KEY).as_deref() {
        Some("stream") => "stream".to_string(),
        _ => "local".to_string(),
    }
}

/// Whether Rich Presence is allowed. Missing key means yes.
pub fn discord_on(app: &AppHandle) -> bool {
    let (_, doc) = document(app);
    doc.get(DISCORD_KEY)
        .and_then(|item| item.as_bool())
        .unwrap_or(true)
}

fn current(app: &AppHandle) -> Settings {
    let root = data::data_root(app.clone());
    Settings {
        source: source(app),
        discord: discord_on(app),
        config_file: root.config_file.clone(),
        data_root_setting: data::config_str(app, ROOT_KEY).unwrap_or_default(),
        data_root: root,
    }
}

/// Everything the Settings page shows.
#[tauri::command]
pub fn settings_get(app: AppHandle) -> Settings {
    current(&app)
}

/// Change one setting and hand back the lot.
///
/// The key is checked against the three this page owns; anything else
/// is refused rather than written, so a typo in the frontend cannot
/// plant a stray key in the file. `value` is a JSON string or bool.
#[tauri::command]
pub fn settings_set(app: AppHandle, key: String, value: serde_json::Value) -> Result<Settings, String> {
    let (file, mut doc) = document(&app);
    let file = file.ok_or("no config directory")?;

    match key.as_str() {
        SOURCE_KEY => {
            let mode = value.as_str().unwrap_or("");
            if mode != "local" && mode != "stream" {
                return Err(format!("source must be local or stream, not {:?}", mode));
            }
            doc[SOURCE_KEY] = toml_edit::value(mode);
        }
        DISCORD_KEY => {
            let on = value.as_bool().ok_or("discord must be true or false")?;
            doc[DISCORD_KEY] = toml_edit::value(on);
        }
        ROOT_KEY => {
            // Empty clears the setting and the lookup rules take over.
            // Forward slashes, so the file reads the same way the
            // template says to write it by hand.
            let path = value.as_str().unwrap_or("").replace('\\', "/");
            if !path.is_empty() && !std::path::Path::new(&path).is_dir() {
                return Err(format!("{} is not a folder", path));
            }
            doc[ROOT_KEY] = toml_edit::value(path);
        }
        other => return Err(format!("not a setting: {}", other)),
    }

    std::fs::write(&file, doc.to_string()).map_err(|err| format!("{}: {}", file.to_string_lossy(), err))?;
    Ok(current(&app))
}

/// A native folder dialog. Async so the blocking dialog runs on a
/// worker thread and the window stays responsive behind it. None if
/// the person cancelled.
#[tauri::command]
pub async fn pick_folder() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Choose the archive folder")
        .pick_folder()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
}
