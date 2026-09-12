//! Finding things at runtime.
//!
//! Every path this app needs used to be baked in with
//! env!("CARGO_MANIFEST_DIR"), which freezes the developer's own folder
//! layout into the binary. That works exactly once, on the machine that
//! compiled it, and fails silently everywhere else: the app still opens,
//! finds no catalogue, and quietly asks the live archive instead.
//!
//! Nothing here is known at compile time. The executable is asked where
//! it is, the OS is asked where configuration belongs, and the archive
//! is looked for in a short list of sensible places.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// How far up from the executable to look for a repo checkout. In a dev
/// build the exe sits at <repo>/desktop/src-tauri/target/debug/, which
/// is four levels down, so six is enough with room to spare and stops
/// well short of walking the whole drive.
const WALK_LIMIT: usize = 6;

/// Where a path came from. Carried through to the frontend so a wrong
/// folder is diagnosable rather than mysterious.
pub type Found = (PathBuf, String);

/// Strip the \\?\ verbatim prefix Windows canonicalisation adds.
///
/// It has to go: convertFileSrc builds an asset URL out of this, and the
/// webview will not load one built from a verbatim path.
pub fn tidy(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().to_string();
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

/// Absolute, tidied, and only if it is really there.
fn real(path: PathBuf) -> Option<PathBuf> {
    if !path.exists() {
        return None;
    }
    Some(tidy(path.canonicalize().unwrap_or(path)))
}

/// The folder holding the running executable.
pub fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

/// Look up the tree from the executable for `<ancestor>/<needle>`.
///
/// This is the one that replaces CARGO_MANIFEST_DIR. In a dev build the
/// exe is inside the checkout, so `web/data` is found without any
/// configuration at all. In a build that has been moved or installed
/// elsewhere the walk finds nothing, which is the correct answer rather
/// than a stale absolute path.
pub fn walk_up_for(needle: &str) -> Option<PathBuf> {
    let start = exe_dir()?;
    start
        .ancestors()
        .take(WALK_LIMIT)
        .map(|dir| dir.join(needle))
        .find(|candidate| candidate.exists())
        .and_then(real)
}

/// The OS folder for this app's configuration.
///
/// app_config_dir rather than app_data_dir: config.toml is meant to be
/// opened in a text editor by the person running this, which is what the
/// config directory is for. On Windows the two resolve to the same
/// %APPDATA% folder, so the distinction costs nothing here and is
/// already correct if this is ever built anywhere else.
pub fn config_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok()
}

/// The OS folder for this app's own data.
pub fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

/// Where Tauri unpacks anything listed in bundle.resources.
pub fn resource_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok()
}

/// First candidate that exists, with the label saying which rule won.
pub fn first_of(candidates: Vec<(Option<PathBuf>, &str)>) -> Option<Found> {
    for (path, label) in candidates {
        if let Some(found) = path.and_then(real) {
            return Some((found, label.to_string()));
        }
    }
    None
}

/// A path out of the environment, ignoring an empty variable.
pub fn from_env(key: &str) -> Option<PathBuf> {
    let value = std::env::var_os(key)?;
    if value.is_empty() {
        return None;
    }
    Some(PathBuf::from(value))
}
