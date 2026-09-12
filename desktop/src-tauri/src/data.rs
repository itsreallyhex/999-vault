//! Where the archive lives on disk, and reading the two JSON indexes out
//! of it.
//!
//! The app does not carry its own copy of the archive. The catalogue is
//! 1.67 MB, the covers are 102 MB and the audio is nearly 26 GB, so the
//! desktop app reads the same folder the site does rather than
//! duplicating any of it. That is a data dependency, not a code one:
//! nothing here imports from web/, and the path is configurable so the
//! folder can be moved anywhere later.
//!
//! Resolution order, first hit wins:
//!
//!   1. NINE_DATA_ROOT in the environment.
//!   2. data_root in src-tauri/config.toml.
//!   3. ../../web/data, resolved from this crate at compile time.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Environment variable that overrides everything else.
pub const ENV_ROOT: &str = "NINE_DATA_ROOT";

/// What the frontend is told about the archive on disk.
#[derive(Serialize, Clone, Debug)]
pub struct DataRoot {
    /// Absolute path, in native form, ready for convertFileSrc.
    pub path: String,
    /// Which of the three rules above answered. Shown in the window so a
    /// wrong folder is visible rather than mysterious.
    pub source: String,
    pub exists: bool,
    pub catalogue: bool,
    pub covers: bool,
    pub audio: bool,
    pub audio_index: bool,
}

/// Strip the \\?\ verbatim prefix Windows canonicalisation adds.
///
/// It has to go: convertFileSrc turns the path into an asset URL, and the
/// webview will not load one built from a verbatim path.
fn tidy(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().to_string();
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

fn config_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("config.toml")
}

/// data_root out of src-tauri/config.toml, if it is set to anything.
fn from_config() -> Option<PathBuf> {
    let text = std::fs::read_to_string(config_path()).ok()?;
    let parsed: toml::Value = text.parse().ok()?;
    let value = parsed.get("data_root")?.as_str()?.trim().to_string();
    if value.is_empty() {
        return None;
    }
    Some(PathBuf::from(value))
}

/// The folder the app reads the archive out of, and which rule found it.
pub fn resolve() -> (PathBuf, String) {
    if let Some(value) = std::env::var_os(ENV_ROOT) {
        let path = PathBuf::from(value);
        if !path.as_os_str().is_empty() {
            return (tidy(path.canonicalize().unwrap_or(path.clone())), ENV_ROOT.to_string());
        }
    }

    if let Some(path) = from_config() {
        return (
            tidy(path.canonicalize().unwrap_or(path.clone())),
            "config.toml".to_string(),
        );
    }

    let fallback = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/data");
    (
        tidy(fallback.canonicalize().unwrap_or(fallback.clone())),
        "default (../../web/data)".to_string(),
    )
}

/// Describe the archive folder, including what is actually in it.
///
/// Missing pieces are reported rather than treated as errors. A machine
/// with the catalogue but no audio is a normal state: the site behaves
/// the same way, and the player says so per track.
#[tauri::command]
pub fn data_root() -> DataRoot {
    let (root, source) = resolve();

    DataRoot {
        exists: root.is_dir(),
        catalogue: root.join("catalogue.json").is_file(),
        covers: root.join("covers").is_dir(),
        audio: root.join("audio").is_dir(),
        audio_index: root.join("audio-index.json").is_file(),
        path: root.to_string_lossy().to_string(),
        source,
    }
}

fn read_json(name: &str) -> Result<serde_json::Value, String> {
    let (root, _) = resolve();
    let file = root.join(name);

    let text = std::fs::read_to_string(&file)
        .map_err(|err| format!("{}: {}", file.to_string_lossy(), err))?;

    serde_json::from_str(&text).map_err(|err| format!("{}: {}", name, err))
}

/// The saved catalogue, exactly as tools/save-catalogue.py wrote it.
///
/// This replaces the site's fetch of a relative path. The shape is
/// untouched, so api.js parses the result through the same code either
/// way, and a failure here is what makes the frontend fall through to
/// the live archive and then to the bundled seed.
#[tauri::command]
pub fn read_catalogue() -> Result<serde_json::Value, String> {
    read_json("catalogue.json")
}

/// Record id to saved filename. The only reliable way to turn a record
/// into a path, because the extension follows the source file and the
/// title is sanitised on the way to disk.
#[tauri::command]
pub fn read_audio_index() -> Result<serde_json::Value, String> {
    read_json("audio-index.json")
}
