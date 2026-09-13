//! Where the archive lives, and reading the two JSON indexes out of it.
//!
//! The app does not carry the archive. The covers are 102 MB and the
//! audio is nearly 26 GB, so it reads the same folder the site does
//! rather than duplicating any of it. It points; it never copies.
//!
//! Resolution order, first one that exists wins:
//!
//!   1. NINE_DATA_ROOT in the environment.
//!   2. data_root in config.toml, in the OS config directory.
//!   3. A data folder beside the executable.
//!   4. A data folder in the OS app data directory.
//!   5. web/data in a checkout above the executable.
//!
//! The one exception to "never copies" is the catalogue, which is
//! 1.67 MB and the difference between an app that opens and one that
//! asks the live archive on every launch. The installer carries a copy
//! (bundle.resources, under seed/), and when none of the five rules
//! finds anything the app writes it into rule 4's folder once, with
//! every cover pointed back at the archive's CDN because a fresh
//! machine has no covers on disk. From then on rule 4 answers. A
//! machine that has an archive never sees this: the seed is only read
//! when nothing else exists.
//!
//! None of that is known at compile time, which is the point: the same
//! binary works from the build directory, from a folder it was copied
//! to, and on a machine that never saw this source tree.

use std::path::PathBuf;

use serde::Serialize;
use tauri::AppHandle;

use crate::paths;

/// Overrides everything else.
pub const ENV_ROOT: &str = "NINE_DATA_ROOT";

const CONFIG_NAME: &str = "config.toml";

/// Written into the OS config directory the first time it is looked for,
/// so there is something to edit and somewhere obvious to look.
const TEMPLATE: &str = r#"# 999 desktop configuration.
#
# data_root is the folder holding catalogue.json, covers/, audio/ and
# audio-index.json. Leave it empty and the app looks, in order, for a
# data folder beside the executable, then one in this folder, then a
# web/data in a checkout above the executable. If none of those exists
# it writes the catalogue the installer came with into a data folder
# here, so the app works with nothing else on the machine: covers come
# from the archive and songs stream from it.
#
# tools_dir is the folder holding save-catalogue.py, sync.py and
# save-audio.py. Same idea, looking for tools and then web/tools.
#
# pages_dir is the folder holding the app's own pages: shell.html, js/
# and css/. Leave it empty and the app looks for a pages folder beside
# the executable, then desktop/src in a checkout above it, then the
# copy the installer bundled. Point it at a checkout and an edit to a
# page is a reload in the window (Ctrl+R), with no rebuild.
#
# discord_client_id is the application id from discord.com/developers,
# for the "Listening to" status. Leave it empty and the app uses the
# id it was built with, which shows as "999 Vault".
#
# All four are overridden by the environment: NINE_DATA_ROOT,
# NINE_TOOLS_DIR, NINE_PAGES_DIR, NINE_DISCORD_ID.

data_root = ""
tools_dir = ""
pages_dir = ""
discord_client_id = ""

# The two below are what the Settings page in the app changes. They
# can be edited here just the same.
#
# source is "local" to play the file on disk and stream from the
# archive only when there is none, or "stream" to play from the
# archive and fall back to the file if the archive fails.
#
# discord is false to keep the "Listening to" status off Discord.
#
# updates is false to stop the app asking the release page for a newer
# version when it opens. Settings has a Check now button either way.

source = "local"
discord = true
updates = true
"#;

/// What the frontend is told about the archive.
#[derive(Serialize, Clone, Debug)]
pub struct DataRoot {
    /// Absolute, native, ready for convertFileSrc. Empty if nothing was found.
    pub path: String,
    /// Which rule answered. Shown so a wrong folder is diagnosable.
    pub source: String,
    /// Where to edit the setting, whatever the outcome was.
    pub config_file: String,
    pub exists: bool,
    pub catalogue: bool,
    pub covers: bool,
    pub audio: bool,
    pub audio_index: bool,
}

/// The config file, created from the template if it is not there yet.
pub fn config_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = paths::config_dir(app)?;
    let file = dir.join(CONFIG_NAME);

    if !file.exists() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(&file, TEMPLATE);
    }

    Some(file)
}

/// One string out of the config file, ignoring a key set to nothing.
pub fn config_str(app: &AppHandle, key: &str) -> Option<String> {
    let text = std::fs::read_to_string(config_file(app)?).ok()?;
    let parsed: toml::Value = text.parse().ok()?;
    let value = parsed.get(key)?.as_str()?.trim().to_string();

    if value.is_empty() {
        return None;
    }
    Some(value)
}

/// One path out of the config file, ignoring a key set to nothing.
pub fn from_config(app: &AppHandle, key: &str) -> Option<PathBuf> {
    config_str(app, key).map(PathBuf::from)
}

/// The archive folder, and the name of the rule that found it.
pub fn resolve(app: &AppHandle) -> (PathBuf, String) {
    paths::first_of(vec![
        (paths::from_env(ENV_ROOT), ENV_ROOT),
        (from_config(app, "data_root"), "config.toml"),
        (paths::exe_dir().map(|dir| dir.join("data")), "data beside the executable"),
        (paths::data_dir(app).map(|dir| dir.join("data")), "the app data folder"),
        (paths::walk_up_for("web/data"), "web/data above the executable"),
    ])
    .or_else(|| seed(app).map(|dir| (dir, "seeded from the installer".to_string())))
    .unwrap_or_else(|| (PathBuf::new(), "not found".to_string()))
}

/// Where the bundled catalogue lands: `seed/catalogue.json` under the
/// resource directory, per bundle.resources in tauri.conf.json.
const SEED_NAME: &str = "seed/catalogue.json";

/// The archive's cover endpoint. The cover id is the record id on
/// every record (measured: 3,879 of 3,879), and the URL answers with no
/// `?v=`, so a cover can be pointed at the CDN knowing only the record.
const COVER_CDN: &str = "/cdn/music/covers/";

/// Make a data folder out of the catalogue the installer carries.
///
/// Only reached when nothing else was found. Writes `catalogue.json`
/// into the app data folder with each `cover` repointed from the
/// checkout's `data/covers/<sha1>.webp` to the CDN, since the covers
/// themselves are not shipped, and `covers` set to "cdn" so the file
/// says what it is. Returns the folder, which rule 4 finds from then
/// on. Any failure returns None and the app falls through to the live
/// archive as before; nothing here is fatal.
fn seed(app: &AppHandle) -> Option<PathBuf> {
    let source = paths::resource_dir(app)?.join(SEED_NAME);
    let text = std::fs::read_to_string(&source).ok()?;
    let mut snapshot: serde_json::Value = serde_json::from_str(&text).ok()?;

    if let Some(songs) = snapshot.get_mut("songs").and_then(|v| v.as_array_mut()) {
        for song in songs.iter_mut() {
            let id = match song.get("id").and_then(|v| v.as_str()) {
                Some(id) => id.to_string(),
                None => continue,
            };
            let local = song
                .get("cover")
                .and_then(|v| v.as_str())
                .map(|c| c.starts_with("data/covers/"))
                .unwrap_or(false);
            if local {
                song["cover"] = serde_json::Value::String(format!("{}{}", COVER_CDN, id));
            }
        }
    }
    snapshot["covers"] = serde_json::Value::String("cdn".to_string());

    let dir = paths::data_dir(app)?.join("data");
    std::fs::create_dir_all(&dir).ok()?;
    let out = serde_json::to_string(&snapshot).ok()?;
    std::fs::write(dir.join("catalogue.json"), out).ok()?;

    println!("999: seeded    {} from the installer's catalogue", dir.to_string_lossy());
    Some(paths::tidy(dir.canonicalize().unwrap_or(dir)))
}

/// Describe the archive folder, including what is actually in it.
///
/// Missing pieces are reported, not treated as errors. A machine with the
/// catalogue but no audio is a normal state, and so is a machine with
/// nothing at all: the Vault falls through to the live archive.
#[tauri::command]
pub fn data_root(app: AppHandle) -> DataRoot {
    let (root, source) = resolve(&app);
    let found = !root.as_os_str().is_empty() && root.is_dir();

    DataRoot {
        exists: found,
        catalogue: found && root.join("catalogue.json").is_file(),
        covers: found && root.join("covers").is_dir(),
        audio: found && root.join("audio").is_dir(),
        audio_index: found && root.join("audio-index.json").is_file(),
        path: root.to_string_lossy().to_string(),
        source,
        config_file: config_file(&app)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    }
}

pub fn read_json(app: &AppHandle, name: &str) -> Result<serde_json::Value, String> {
    let (root, source) = resolve(app);
    if root.as_os_str().is_empty() {
        return Err(format!("no archive folder found ({})", source));
    }

    let file = root.join(name);
    let text = std::fs::read_to_string(&file)
        .map_err(|err| format!("{}: {}", file.to_string_lossy(), err))?;

    serde_json::from_str(&text).map_err(|err| format!("{}: {}", name, err))
}

/// The saved catalogue, exactly as tools/save-catalogue.py wrote it.
#[tauri::command]
pub fn read_catalogue(app: AppHandle) -> Result<serde_json::Value, String> {
    read_json(&app, "catalogue.json")
}

/// Record id to saved filename. The only reliable way to turn a record
/// into a path, because the extension follows the source file and the
/// title is sanitised on the way to disk.
#[tauri::command]
pub fn read_audio_index(app: AppHandle) -> Result<serde_json::Value, String> {
    read_json(&app, "audio-index.json")
}
