//! Updating the app from a GitHub release.
//!
//! Asked for 2026-09-13: "when I release a new release the app needs to
//! update itself, not by force: a pop-up saying a new release is out,
//! with Update and Remind me later". This is the Rust half. Tauri's
//! updater plugin does the work: it fetches `latest.json` from the
//! release, compares the version in it with the one compiled into this
//! binary, and on Update downloads the installer, checks its signature
//! against the public key in tauri.conf.json, runs it quietly and exits
//! so the installer can relaunch the app. The frontend never touches the
//! plugin: the shell calls these two commands and listens for the
//! progress event, which keeps tauri.js the only module talking to Rust
//! and keeps the pop-up in the shell's own markup.
//!
//! Nothing here runs unless the shell asks, and the shell only asks on
//! launch when the `updates` setting is on, or when the person presses
//! Check now. One GET to GitHub per launch is the whole cost.
//!
//! The release side is scripts/release.ps1: it builds with the signing
//! key, writes latest.json and uploads the lot. Without a latest.json
//! on the latest release the check finds nothing and says so.

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// What the shell draws in the pop-up.
#[derive(Serialize, Clone, Debug)]
pub struct UpdateInfo {
    pub available: bool,
    /// The version this binary is.
    pub current: String,
    /// The version on offer, when there is one.
    pub version: Option<String>,
    /// The release notes, as written in latest.json.
    pub notes: Option<String>,
    /// The release date, RFC 3339, when the manifest carries one.
    pub date: Option<String>,
}

/// Progress, emitted as `update-progress` while the installer downloads.
#[derive(Serialize, Clone, Debug)]
struct Progress {
    got: u64,
    total: Option<u64>,
    done: bool,
}

/// Ask the release for a newer version. A network failure is an error
/// the shell can show on a manual check and ignore on launch.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let updater = app.updater().map_err(|err| err.to_string())?;
    let found = updater.check().await.map_err(describe)?;

    Ok(match found {
        Some(update) => UpdateInfo {
            available: true,
            current,
            version: Some(update.version.clone()),
            notes: update.body.clone(),
            date: update.date.map(|d| d.to_string()),
        },
        None => UpdateInfo { available: false, current, version: None, notes: None, date: None },
    })
}

/// Download the update, verify it, install it and relaunch. Progress
/// goes out as `update-progress`. On Windows the plugin hands over to
/// the installer and exits this process, so this normally never returns
/// on success; the restart at the end is for a platform where it does.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|err| err.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(describe)?
        .ok_or("There is no newer version to install")?;

    let progress = app.clone();
    let mut got: u64 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                got += chunk as u64;
                let _ = progress.emit("update-progress", Progress { got, total, done: false });
            },
            || {},
        )
        .await
        .map_err(describe)?;

    let _ = app.emit("update-progress", Progress { got: 0, total: None, done: true });
    app.restart();
}

/// One line for the pop-up, out of whatever the plugin raised.
fn describe(err: tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error;
    match err {
        Error::Network(_) | Error::Reqwest(_) => "The release page could not be reached".to_string(),
        Error::ReleaseNotFound => "No release carries an update manifest yet".to_string(),
        other => other.to_string(),
    }
}
