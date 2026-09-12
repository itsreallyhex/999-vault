//! Running the Python scripts.
//!
//! save-catalogue.py, sync.py and save-audio.py are not reimplemented
//! here and are not going to be. They already know how the archive
//! answers: the bearer token expiry, the /stream fallback for the three
//! records /download refuses, the Content-Length verification and the
//! cover deduplication all live in those files.
//!
//! So the app shells out to them and reads what they print. Where they
//! are is worked out at runtime, the same way the archive folder is.

use std::path::PathBuf;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

use crate::data;
use crate::paths;

/// Overrides everything else.
pub const ENV_TOOLS: &str = "NINE_TOOLS_DIR";

/// The scripts that may be run, and nothing else. A name that is not on
/// this list is refused rather than passed through to a shell.
const SCRIPTS: [&str; 3] = ["save-catalogue.py", "sync.py", "save-audio.py"];

#[derive(Serialize, Clone, Debug)]
pub struct ToolOutput {
    pub script: String,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// The folder holding the scripts, and the rule that found it.
///
/// resource_dir is in the list because that is where these would land if
/// they were added to bundle.resources later. Nothing puts them there
/// today, so it simply misses and the walk finds the checkout.
pub fn tools_dir(app: &AppHandle) -> Option<(PathBuf, String)> {
    paths::first_of(vec![
        (paths::from_env(ENV_TOOLS), ENV_TOOLS),
        (data::from_config(app, "tools_dir"), "config.toml"),
        (paths::exe_dir().map(|dir| dir.join("tools")), "tools beside the executable"),
        (paths::resource_dir(app).map(|dir| dir.join("tools")), "bundled resources"),
        (paths::walk_up_for("web/tools"), "web/tools above the executable"),
    ])
}

/// Is the Python side reachable, and are the scripts where we expect?
#[tauri::command]
pub fn tools_status(app: AppHandle) -> serde_json::Value {
    match tools_dir(&app) {
        Some((dir, source)) => serde_json::json!({
            "dir": dir.to_string_lossy(),
            "source": source,
            "exists": true,
            "scripts": SCRIPTS.iter().map(|name| serde_json::json!({
                "name": name,
                "present": dir.join(name).is_file(),
            })).collect::<Vec<_>>(),
        }),
        None => serde_json::json!({
            "dir": "", "source": "not found", "exists": false,
            "scripts": SCRIPTS.iter().map(|name| serde_json::json!({
                "name": name, "present": false,
            })).collect::<Vec<_>>(),
        }),
    }
}

/// Run one of the three scripts and hand back what it printed.
///
/// This waits for the script to finish. save-audio.py on a full run takes
/// twenty minutes, so anything long running wants streaming output
/// instead, which is a later problem: nothing calls it yet.
#[tauri::command]
pub async fn run_tool(
    app: AppHandle,
    script: String,
    args: Vec<String>,
) -> Result<ToolOutput, String> {
    if !SCRIPTS.contains(&script.as_str()) {
        return Err(format!("not a known script: {}", script));
    }

    let (dir, _) = tools_dir(&app).ok_or_else(|| "no tools folder found".to_string())?;
    let path = dir.join(&script);
    if !path.is_file() {
        return Err(format!("missing: {}", path.to_string_lossy()));
    }

    let mut call = vec![path.to_string_lossy().to_string()];
    call.extend(args);

    let output = app
        .shell()
        .command("python")
        .args(call)
        .output()
        .await
        .map_err(|err| format!("could not run python: {}", err))?;

    Ok(ToolOutput {
        script,
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}
