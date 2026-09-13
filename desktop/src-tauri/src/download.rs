//! Saving one track to the archive folder from inside the app.
//!
//! The bar's download button. It does for one record what
//! web/tools/save-audio.py does for thousands, and it does it the same
//! way so the two never disagree about what is on disk:
//!
//!   - the file is named `<title> [<id8>].<ext>`, the title cleaned for
//!     Windows exactly as `safe_name()` cleans it, the extension taken
//!     from the record's `file_name`;
//!   - the bytes come through the metered `/music/download/<id>`, on
//!     purpose. The archive announces 500 a day for anonymous use and
//!     metering exactly one of its two audio paths is how it counts.
//!     `/music/stream/` is tried only after `/download` has answered
//!     5xx for this exact record, which it does for three whose
//!     `file_name` a Content-Disposition header cannot carry;
//!   - the download is verified against the response's Content-Length,
//!     never against the catalogue, whose figure is a few dozen bytes
//!     off on many tracks;
//!   - `audio-index.json` is rewritten in the script's layout, so the
//!     player, `sync.py` and a later `save-audio.py` run all read it.
//!
//! One record per call. A whole-archive pull is still the script's job.

use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;

use crate::data;

const API_BASE: &str = "https://api.juicevault.xyz";
/// The cover CDN 403s a bare `Python-urllib`; the API itself has not
/// been seen to care, but a name costs nothing.
const USER_AGENT: &str = "999 Vault/0.1";
const INDEX_NAME: &str = "audio-index.json";
const INDEX_NOTE: &str = "song id -> saved audio file. Rebuildable by re-running; \
files already on disk with the right size are not refetched.";

/// What the bar gets back.
#[derive(Serialize, Clone, Debug)]
pub struct Saved {
    pub rid: String,
    /// The filename under `<archive>/audio/`, as the index records it.
    pub file: String,
    pub bytes: u64,
    /// True when the file was already there with the right size and
    /// nothing was fetched.
    pub already: bool,
    /// "download", "stream" (the 5xx fallback) or "disk".
    pub via: String,
}

/// `<title> [<id8>].<ext>`, cleaned for Windows, falling back to the id.
/// Mirrors `safe_name()` in save-audio.py character for character.
fn safe_name(title: &str, id: &str, file_name: &str) -> String {
    let ext = Path::new(file_name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_else(|| ".mp3".to_string());

    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim_matches(|c| c == ' ' || c == '.');
    let collapsed = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
    let stem: String = collapsed.chars().take(120).collect();
    let stem = if stem.is_empty() { id.to_string() } else { stem };

    let id8: String = id.chars().take(8).collect();
    format!("{} [{}]{}", stem, id8, ext)
}

/// The record's title and file_name out of the saved catalogue.
fn record(app: &AppHandle, rid: &str) -> Result<(String, String), String> {
    let catalogue = data::read_json(app, "catalogue.json")?;
    let songs = catalogue
        .get("songs")
        .and_then(|s| s.as_array())
        .ok_or("the catalogue has no songs list")?;

    let song = songs
        .iter()
        .find(|s| s.get("id").and_then(|v| v.as_str()) == Some(rid))
        .ok_or("that record is not in the saved catalogue")?;

    let title = song.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let file_name = song.get("file_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    Ok((title, file_name))
}

/// The index as a JSON object, or a fresh one if the file is missing
/// or unreadable. Unreadable is treated as missing on purpose: the
/// index is rebuildable, and one bad byte should not block a save.
fn read_index(path: &Path) -> serde_json::Map<String, serde_json::Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|v| match v {
            serde_json::Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

/// Put one entry in and write the file back in the script's layout:
/// `note`, `tracks`, `bytes`, `by_id`.
fn write_index(path: &Path, rid: &str, file: &str, bytes: u64) -> Result<(), String> {
    let mut index = read_index(path);

    let mut by_id = match index.remove("by_id") {
        Some(serde_json::Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };
    by_id.insert(
        rid.to_string(),
        serde_json::json!({ "file": file, "bytes": bytes }),
    );

    let total: u64 = by_id
        .values()
        .filter_map(|v| v.get("bytes").and_then(|b| b.as_u64()))
        .sum();

    let mut out = serde_json::Map::new();
    out.insert("note".into(), serde_json::Value::String(INDEX_NOTE.into()));
    out.insert("tracks".into(), serde_json::Value::from(by_id.len()));
    out.insert("bytes".into(), serde_json::Value::from(total));
    out.insert("by_id".into(), serde_json::Value::Object(by_id));

    let text = serde_json::to_string_pretty(&serde_json::Value::Object(out))
        .map_err(|err| err.to_string())?;
    std::fs::write(path, text).map_err(|err| format!("{}: {}", path.to_string_lossy(), err))
}

/// Fetch `url` into `part`, returning the byte count. Verified against
/// Content-Length when the server sends one; a short file is deleted
/// and reported rather than kept.
fn fetch(agent: &ureq::Agent, url: &str, part: &Path) -> Result<u64, ureq::Error> {
    let response = agent.get(url).call()?;
    let declared: Option<u64> = response
        .header("Content-Length")
        .and_then(|v| v.trim().parse().ok());

    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(part)?;
    let mut buf = vec![0u8; 1 << 16];
    let mut got: u64 = 0;

    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])?;
        got += n as u64;
    }
    file.flush()?;
    drop(file);

    if let Some(want) = declared {
        if want != got {
            let _ = std::fs::remove_file(part);
            return Err(ureq::Error::from(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                format!("got {} of {} bytes", got, want),
            )));
        }
    }
    Ok(got)
}

/// The whole job, on a blocking thread. See the module comment.
fn save(app: &AppHandle, rid: &str) -> Result<Saved, String> {
    let (root, source) = data::resolve(app);
    if root.as_os_str().is_empty() {
        return Err(format!("No archive folder to save into ({})", source));
    }

    let (title, file_name) = record(app, rid)?;
    let audio_dir: PathBuf = root.join("audio");
    let index_path = root.join(INDEX_NAME);

    // Already saved under this or an earlier name? Trust the index's
    // byte count, the way the script does.
    let index = read_index(&index_path);
    let known = index
        .get("by_id")
        .and_then(|m| m.get(rid))
        .and_then(|e| {
            Some((
                e.get("file")?.as_str()?.to_string(),
                e.get("bytes")?.as_u64()?,
            ))
        });
    if let Some((file, bytes)) = known {
        if let Ok(meta) = std::fs::metadata(audio_dir.join(&file)) {
            if meta.len() == bytes {
                return Ok(Saved { rid: rid.into(), file, bytes, already: true, via: "disk".into() });
            }
        }
    }

    std::fs::create_dir_all(&audio_dir)
        .map_err(|err| format!("{}: {}", audio_dir.to_string_lossy(), err))?;

    let name = safe_name(&title, rid, &file_name);
    let dest = audio_dir.join(&name);
    let part = audio_dir.join(format!("{}.part", name));

    let agent = ureq::AgentBuilder::new()
        .user_agent(USER_AGENT)
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(60))
        .build();

    let download = format!("{}/music/download/{}", API_BASE, rid);
    let (bytes, via) = match fetch(&agent, &download, &part) {
        Ok(n) => (n, "download"),
        Err(ureq::Error::Status(429, _)) => {
            let _ = std::fs::remove_file(&part);
            return Err("The archive's daily allowance is used up. Try again tomorrow.".into());
        }
        Err(ureq::Error::Status(404, _)) => {
            let _ = std::fs::remove_file(&part);
            return Err("The archive has no such record".into());
        }
        Err(ureq::Error::Status(code, _)) if (500..600).contains(&code) => {
            // Broken on their side for this record: the same three the
            // script knows about. Same bytes from /stream, no header.
            let _ = std::fs::remove_file(&part);
            let stream = format!("{}/music/stream/{}", API_BASE, rid);
            match fetch(&agent, &stream, &part) {
                Ok(n) => (n, "stream"),
                Err(err) => {
                    let _ = std::fs::remove_file(&part);
                    return Err(describe(err));
                }
            }
        }
        Err(err) => {
            let _ = std::fs::remove_file(&part);
            return Err(describe(err));
        }
    };

    if dest.exists() {
        let _ = std::fs::remove_file(&dest);
    }
    std::fs::rename(&part, &dest)
        .map_err(|err| format!("{}: {}", dest.to_string_lossy(), err))?;

    write_index(&index_path, rid, &name, bytes)?;

    Ok(Saved { rid: rid.into(), file: name, bytes, already: false, via: via.into() })
}

/// One line for the bar, out of whatever ureq raised.
fn describe(err: ureq::Error) -> String {
    match err {
        ureq::Error::Status(code, _) => format!("The archive answered {}", code),
        ureq::Error::Transport(t) => match t.kind() {
            ureq::ErrorKind::Io => format!("The download stopped short: {}", t),
            _ => "The archive could not be reached".to_string(),
        },
    }
}

/// Save one record's audio into the archive folder. Async so the
/// webview is not held while the bytes come down; the work itself is
/// blocking I/O on a worker thread.
#[tauri::command]
pub async fn download_track(app: AppHandle, rid: String) -> Result<Saved, String> {
    tauri::async_runtime::spawn_blocking(move || save(&app, &rid))
        .await
        .map_err(|err| format!("download thread failed: {}", err))?
}

#[cfg(test)]
mod tests {
    use super::safe_name;

    #[test]
    fn names_match_the_script() {
        assert_eq!(
            safe_name("10 Feet (Sessions)", "7f32cc12-a785-4e8c-9d5f-3803bdb54d7a", "x.mp3"),
            "10 Feet (Sessions) [7f32cc12].mp3"
        );
        assert_eq!(safe_name("What: A/B?", "abcdef0123", "y.M4A"), "What_ A_B_ [abcdef01].m4a");
        assert_eq!(safe_name("  dots.. ", "abcdef0123", ""), "dots [abcdef01].mp3");
        assert_eq!(safe_name("", "abcdef0123", "z.wav"), "abcdef0123 [abcdef01].wav");
        // A tab is a control character first and whitespace second, so it
        // becomes an underscore before the run is collapsed. The script
        // does the same.
        assert_eq!(safe_name("a   b\tc", "abcdef0123", "z.mp3"), "a b_c [abcdef01].mp3");
    }
}
