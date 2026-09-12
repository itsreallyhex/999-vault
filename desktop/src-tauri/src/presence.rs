//! Discord Rich Presence.
//!
//! What is playing, on the owner's Discord profile, as a "Listening to
//! 999" activity: the title, the cover, and a bar with elapsed and total
//! time. Paused, the bar goes and the second line reads "Paused" with a
//! timer counting up from the pause.
//!
//! The frontend decides what to show and when; this module only carries
//! it down the local IPC pipe. Discord not running, or no client id set,
//! is an ordinary state: every call answers `false` and nothing else in
//! the app hears about it. A failed connection is not retried for a
//! while, so a machine without Discord does not pay for a pipe lookup on
//! every play and pause.
//!
//! The cover is a URL on the archive's CDN, which Discord's own servers
//! fetch. The covers on disk cannot be handed over: Discord will not read
//! a local file, and the app never makes that request itself.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use discord_rich_presence::activity::{Activity, ActivityType, Assets, Timestamps};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::data;

/// Overrides the config file.
pub const ENV_ID: &str = "NINE_DISCORD_ID";

/// Key in config.toml.
const CONFIG_KEY: &str = "discord_client_id";

/// How long to leave Discord alone after a failed connect.
const RETRY_AFTER: Duration = Duration::from_secs(30);

/// What the frontend asks to be shown.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Shown {
    /// The top line: the title.
    pub title: String,
    /// The second line: category and position, or "Paused".
    pub line: String,
    /// The cover, as a URL Discord can fetch. None shows the app's icon.
    pub image: Option<String>,
    /// Unix seconds. Start alone counts up; start and end draw the bar.
    pub start: Option<i64>,
    pub end: Option<i64>,
}

/// What the frontend can ask about.
#[derive(Serialize, Debug)]
pub struct Info {
    pub configured: bool,
    pub connected: bool,
    pub config_file: String,
}

/// One connection, made on first use and dropped on the first error.
#[derive(Default)]
pub struct Presence {
    client: Mutex<Option<DiscordIpcClient>>,
    failed_at: Mutex<Option<Instant>>,
}

/// The application id the binary is built with. Not a secret: it is
/// what Discord's client reads off the pipe, and it names the activity
/// "999 Vault". Here so an install on a machine that has never seen a
/// config file gets the presence without being told about it. The
/// environment and the config file still override it.
const DEFAULT_ID: &str = "1548116060031680664";

/// The client id: the environment first, then config.toml, then the
/// one built in.
fn client_id(app: &AppHandle) -> Option<String> {
    if let Some(value) = std::env::var_os(ENV_ID) {
        let value = value.to_string_lossy().trim().to_string();
        if !value.is_empty() {
            return Some(value);
        }
    }
    data::config_str(app, CONFIG_KEY).or_else(|| Some(DEFAULT_ID.to_string()))
}

/// Make sure there is a live client, or say why not.
fn ensure(app: &AppHandle, presence: &Presence) -> Result<(), String> {
    if presence.client.lock().map_err(|e| e.to_string())?.is_some() {
        return Ok(());
    }

    if let Some(at) = *presence.failed_at.lock().map_err(|e| e.to_string())? {
        if at.elapsed() < RETRY_AFTER {
            return Err("discord: not retrying yet".into());
        }
    }

    let id = client_id(app).ok_or_else(|| "discord: no client id configured".to_string())?;
    let mut client = DiscordIpcClient::new(&id);

    match client.connect() {
        Ok(()) => {
            *presence.client.lock().map_err(|e| e.to_string())? = Some(client);
            *presence.failed_at.lock().map_err(|e| e.to_string())? = None;
            Ok(())
        }
        Err(err) => {
            *presence.failed_at.lock().map_err(|e| e.to_string())? = Some(Instant::now());
            Err(format!("discord: {err}"))
        }
    }
}

/// Forget the client after an error, so the next call reconnects.
fn drop_client(presence: &Presence) {
    if let Ok(mut guard) = presence.client.lock() {
        if let Some(mut client) = guard.take() {
            let _ = client.close();
        }
    }
    if let Ok(mut failed) = presence.failed_at.lock() {
        *failed = Some(Instant::now());
    }
}

/// Show something. `false` means Discord is not there; nothing to do.
#[tauri::command]
pub fn presence_set(app: AppHandle, presence: State<Presence>, shown: Shown) -> Result<bool, String> {
    if ensure(&app, &presence).is_err() {
        return Ok(false);
    }

    let mut timestamps = Timestamps::new();
    if let Some(start) = shown.start {
        timestamps = timestamps.start(start);
    }
    if let Some(end) = shown.end {
        timestamps = timestamps.end(end);
    }

    let mut assets = Assets::new().large_text(shown.title.as_str());
    if let Some(image) = shown.image.as_deref() {
        assets = assets.large_image(image);
    }

    let activity = Activity::new()
        .activity_type(ActivityType::Listening)
        .details(shown.title.as_str())
        .state(shown.line.as_str())
        .timestamps(timestamps)
        .assets(assets);

    let mut guard = presence.client.lock().map_err(|e| e.to_string())?;
    let outcome = match guard.as_mut() {
        Some(client) => client.set_activity(activity),
        None => return Ok(false),
    };
    drop(guard);

    match outcome {
        Ok(()) => Ok(true),
        Err(_) => {
            drop_client(&presence);
            Ok(false)
        }
    }
}

/// Take the activity down. Nothing playing, or the app is closing.
#[tauri::command]
pub fn presence_clear(presence: State<Presence>) -> Result<bool, String> {
    let mut guard = presence.client.lock().map_err(|e| e.to_string())?;
    let outcome = match guard.as_mut() {
        Some(client) => client.clear_activity(),
        None => return Ok(false),
    };
    drop(guard);

    match outcome {
        Ok(()) => Ok(true),
        Err(_) => {
            drop_client(&presence);
            Ok(false)
        }
    }
}

/// Whether a client id is set and whether a connection is up.
#[tauri::command]
pub fn presence_info(app: AppHandle, presence: State<Presence>) -> Info {
    Info {
        configured: client_id(&app).is_some(),
        connected: presence
            .client
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false),
        config_file: data::config_file(&app)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    }
}

/// What to print at startup.
pub fn describe(app: &AppHandle) -> String {
    match client_id(app) {
        Some(id) => format!("client id {}", id),
        None => "no client id. Set discord_client_id in the config file, or NINE_DISCORD_ID.".into(),
    }
}
