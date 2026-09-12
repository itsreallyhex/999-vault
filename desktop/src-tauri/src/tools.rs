//! Running the Python scripts.
//!
//! save-catalogue.py, sync.py and save-audio.py are not reimplemented
//! here and are not going to be. They already know how the archive
//! answers: the bearer token expiry, the /stream fallback for the three
//! records /download refuses, the Content-Length verification and the
//! cover deduplication all live in those files. Rewriting them in Rust
//! would mean maintaining two implementations of the same rules.
//!
//! So the app shells out to them and reads what they print.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

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

/// web/tools, resolved from this crate at compile time.
///
/// Same reasoning as the data root: the scripts stay where they are and
/// the app reaches them, rather than a second copy drifting out of step.
fn tools_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/tools")
}

/// Is the Python side reachable at all, and are the scripts where we
/// expect them? Called before offering any of this in the interface.
#[tauri::command]
pub fn tools_status() -> serde_json::Value {
    let dir = tools_dir();

    serde_json::json!({
        "dir": dir.to_string_lossy(),
        "exists": dir.is_dir(),
        "scripts": SCRIPTS
            .iter()
            .map(|name| {
                serde_json::json!({ "name": name, "present": dir.join(name).is_file() })
            })
            .collect::<Vec<_>>(),
    })
}

/// Run one of the three scripts and hand back what it printed.
///
/// This waits for the script to finish. save-audio.py on a full run
/// takes twenty minutes, so anything long running wants streaming output
/// instead, which is a later problem: nothing in the interface calls it
/// yet.
#[tauri::command]
pub async fn run_tool(
    app: AppHandle,
    script: String,
    args: Vec<String>,
) -> Result<ToolOutput, String> {
    if !SCRIPTS.contains(&script.as_str()) {
        return Err(format!("not a known script: {}", script));
    }

    let path = tools_dir().join(&script);
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
