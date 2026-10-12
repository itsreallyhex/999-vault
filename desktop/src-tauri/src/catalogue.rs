//! Check for new songs, from inside the app.
//!
//! The saved catalogue is a point in time, and until now refreshing it
//! meant running tools/sync.py, which meant Python. This does the same
//! job in two steps the person controls:
//!
//!   catalogue_check   asks the archive for its listing, compares it
//!                     with the saved one by record id, and reports
//!                     what moved. Writes nothing. The listing is held
//!                     in memory for a few minutes.
//!   catalogue_apply   writes what the check showed, and only that.
//!
//! It matches on `id`, never by comparing whole records, for the reason
//! sync.py gives: `cover` is rewritten locally and `play_count` is a
//! counter, so a whole-record diff flags everything as changed.
//!
//! Writing is the one risky thing here, because every page reads this
//! file. So: the listing is sanity checked first (a short or broken one
//! is refused), the new file is written beside the old and read back
//! before it replaces it, and the previous one is kept as
//! `catalogue.json.bak`. Nothing is ever deleted from the archive: a
//! record that left the listing leaves the catalogue, its audio stays.
//!
//! Covers need no download. A record that already had a local cover
//! file keeps it; every other record keeps the archive's own path, which
//! the app already knows how to show.
//!
//! The only request is the one the app already makes to the same host
//! for playback: GET /music/list, with no identifier of any kind.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, State};

use crate::data;

const LIST_URL: &str = "https://api.juicevault.xyz/music/list";
const USER_AGENT: &str = "999-vault";

/// Fields that move on their own and say nothing about a record
/// changing. Same set as sync.py's VOLATILE.
const VOLATILE: [&str; 2] = ["cover", "play_count"];

/// How long a check can be applied for. After this, check again.
const HOLD_FOR: Duration = Duration::from_secs(15 * 60);

/// A listing bigger than this is not a listing.
const MAX_BYTES: u64 = 64 * 1024 * 1024;

/// What a check found, held until it is applied or goes stale.
#[derive(Default)]
pub struct Held(Mutex<Option<(Instant, Vec<Value>)>>);

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Brief {
    pub title: String,
    pub category: String,
}

/// One edited song: its name now, what it was called when the name is
/// what moved, and what changed, in words a person would use.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Edit {
    pub title: String,
    pub category: String,
    /// The old title when the title is one of the changes, else empty.
    pub was: String,
    pub changes: Vec<String>,
}

/// Every title that moved is listed: the Settings page scrolls.
#[derive(Serialize, Debug)]
pub struct Report {
    pub saved_count: usize,
    pub live_count: usize,
    /// When the saved copy was taken, as it says itself.
    pub saved_at: String,
    pub added_total: usize,
    pub added: Vec<Brief>,
    pub removed_total: usize,
    pub removed: Vec<Brief>,
    pub edited_total: usize,
    pub edited: Vec<Edit>,
    /// Of the edited ones, how many changed a title or another name.
    pub retitled_total: usize,
    /// Categories in the listing that the saved copy had none of.
    pub new_categories: Vec<String>,
    /// Nothing moved at all.
    pub unchanged: bool,
}

#[derive(Serialize, Debug)]
pub struct Applied {
    pub count: usize,
    pub added: usize,
    pub removed: usize,
    pub edited: usize,
    /// "local" if any record kept a cover file on this machine.
    pub covers: String,
    /// Whether the previous catalogue was kept as catalogue.json.bak.
    pub backup: bool,
}

/* ---------- Pure parts ---------- */

fn id_of(v: &Value) -> Option<&str> {
    v.get("id").and_then(|x| x.as_str()).filter(|s| !s.is_empty())
}

fn text_of(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

#[derive(Debug, Default, PartialEq)]
struct Diff {
    /// Indexes into the live listing.
    added: Vec<usize>,
    /// Indexes into the saved one.
    removed: Vec<usize>,
    /// Live index and the fields that differ.
    edited: Vec<(usize, Vec<String>)>,
}

fn changed_fields(a: &Value, b: &Value) -> Vec<String> {
    let empty = Map::new();
    let am = a.as_object().unwrap_or(&empty);
    let bm = b.as_object().unwrap_or(&empty);
    let keys: BTreeSet<&String> = am.keys().chain(bm.keys()).collect();
    keys.into_iter()
        .filter(|k| !VOLATILE.contains(&k.as_str()) && am.get(*k) != bm.get(*k))
        .cloned()
        .collect()
}

fn compare(live: &[Value], saved: &[Value]) -> Diff {
    let was: HashMap<&str, &Value> = saved.iter().filter_map(|s| id_of(s).map(|i| (i, s))).collect();
    let now: HashSet<&str> = live.iter().filter_map(id_of).collect();

    let mut diff = Diff::default();
    for (i, song) in live.iter().enumerate() {
        let Some(id) = id_of(song) else { continue };
        match was.get(id) {
            None => diff.added.push(i),
            Some(before) => {
                let fields = changed_fields(song, before);
                if !fields.is_empty() {
                    diff.edited.push((i, fields));
                }
            }
        }
    }
    for (i, song) in saved.iter().enumerate() {
        if let Some(id) = id_of(song) {
            if !now.contains(id) {
                diff.removed.push(i);
            }
        }
    }
    diff
}

fn categories(songs: &[Value]) -> BTreeSet<String> {
    songs
        .iter()
        .map(|s| text_of(s, "category"))
        .filter(|c| !c.is_empty())
        .collect()
}

fn brief(v: &Value) -> Brief {
    Brief { title: text_of(v, "title"), category: text_of(v, "category") }
}

/// A record field as a person would say it. The two size fields are
/// one change.
fn label(field: &str) -> &str {
    match field {
        "title" => "title",
        "alt_names" => "other names",
        "category" => "category",
        "length" => "length",
        "file_name" => "file name",
        "file_size" | "file_size_bytes" => "size",
        "is_session_edit" => "session edit",
        "archive_added_at" => "date added",
        "artist" => "artist",
        other => other,
    }
}

fn report(live: &[Value], saved: &[Value], saved_at: &str) -> Report {
    let diff = compare(live, saved);
    let seen = categories(saved);
    let new_categories: Vec<String> = categories(live)
        .into_iter()
        .filter(|c| !seen.contains(c))
        .collect();

    let retitled_total = diff
        .edited
        .iter()
        .filter(|(_, f)| f.iter().any(|k| k == "title" || k == "alt_names"))
        .count();

    let before: HashMap<&str, &Value> = saved.iter().filter_map(|s| id_of(s).map(|i| (i, s))).collect();
    let edited: Vec<Edit> = diff
        .edited
        .iter()
        .map(|(i, fields)| {
            let song = &live[*i];
            let mut changes: Vec<String> = Vec::new();
            for f in fields {
                let word = label(f).to_string();
                if !changes.contains(&word) {
                    changes.push(word);
                }
            }
            let was = if fields.iter().any(|f| f == "title") {
                id_of(song)
                    .and_then(|id| before.get(id))
                    .map(|old| text_of(old, "title"))
                    .unwrap_or_default()
            } else {
                String::new()
            };
            Edit { title: text_of(song, "title"), category: text_of(song, "category"), was, changes }
        })
        .collect();

    Report {
        saved_count: saved.len(),
        live_count: live.len(),
        saved_at: saved_at.to_string(),
        added_total: diff.added.len(),
        added: diff.added.iter().map(|&i| brief(&live[i])).collect(),
        removed_total: diff.removed.len(),
        removed: diff.removed.iter().map(|&i| brief(&saved[i])).collect(),
        edited_total: diff.edited.len(),
        edited,
        retitled_total,
        new_categories,
        unchanged: diff.added.is_empty() && diff.removed.is_empty() && diff.edited.is_empty(),
    }
}

/// Whether a listing is fit to replace the saved one. A short or
/// broken answer from the archive must never become the catalogue.
fn sane(live: &[Value], saved: &[Value]) -> Result<(), String> {
    if live.is_empty() {
        return Err("The archive's listing was empty, so nothing was changed.".into());
    }
    let whole = live
        .iter()
        .filter(|s| id_of(s).is_some() && !text_of(s, "title").is_empty())
        .count();
    if whole * 100 < live.len() * 99 {
        return Err(format!(
            "The archive's listing looked damaged ({} of {} records had an id and a title), so nothing was changed.",
            whole,
            live.len()
        ));
    }
    if !saved.is_empty() && live.len() * 2 < saved.len() {
        return Err(format!(
            "The archive's listing has {} records against {} saved, which looks incomplete, so nothing was changed.",
            live.len(),
            saved.len()
        ));
    }
    Ok(())
}

/// The listing with each record's cover put back to the local file the
/// saved copy had for it, where that file is still on disk. Returns how
/// many it put back.
fn fold_covers(live: Vec<Value>, saved: &[Value], root: &Path) -> (Vec<Value>, usize) {
    let local: HashMap<&str, &str> = saved
        .iter()
        .filter_map(|s| {
            let id = id_of(s)?;
            let cover = s.get("cover")?.as_str()?;
            if cover.starts_with("data/covers/") { Some((id, cover)) } else { None }
        })
        .collect();

    let mut kept = 0usize;
    let out = live
        .into_iter()
        .map(|mut song| {
            let id = id_of(&song).map(|s| s.to_string());
            if let (Some(id), true) = (id, song.is_object()) {
                if let Some(cover) = local.get(id.as_str()) {
                    let file = root.join(cover.trim_start_matches("data/"));
                    if file.is_file() {
                        song["cover"] = Value::String((*cover).to_string());
                        kept += 1;
                    }
                }
            }
            song
        })
        .collect();
    (out, kept)
}

/// 2026-10-11T14:03:07Z from Unix seconds. No date crate for one line.
fn iso_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // Days since 1970-01-01 to a calendar date (Hinnant's civil_from_days)
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };

    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, d, h, mi, s)
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/* ---------- Disk ---------- */

/// Write the catalogue beside the old one, check it reads back, keep
/// the previous as .bak, and put the new one in place. Returns whether
/// a backup was made.
fn write_catalogue(root: &Path, songs: Vec<Value>, covers: &str) -> Result<bool, String> {
    let count = songs.len();
    let doc = json!({
        "saved_at": iso_utc(now_secs()),
        "source": LIST_URL,
        "count": count,
        "covers": covers,
        "songs": songs,
    });
    let text = serde_json::to_string(&doc).map_err(|e| format!("Could not write the list: {}", e))?;

    let file = root.join("catalogue.json");
    let part = root.join("catalogue.json.part");
    let bak = root.join("catalogue.json.bak");

    std::fs::write(&part, &text)
        .map_err(|e| format!("{}: {}", part.to_string_lossy(), e))?;

    // What was written must be what was meant. A half-written file
    // never replaces a good one.
    let back = std::fs::read_to_string(&part)
        .map_err(|e| format!("{}: {}", part.to_string_lossy(), e))?;
    let ok = serde_json::from_str::<Value>(&back)
        .ok()
        .and_then(|v| v.get("songs").and_then(|s| s.as_array()).map(|a| a.len()))
        == Some(count);
    if !ok {
        let _ = std::fs::remove_file(&part);
        return Err("The new list did not read back correctly, so nothing was changed.".into());
    }

    let backup = file.is_file() && std::fs::copy(&file, &bak).is_ok();
    std::fs::rename(&part, &file)
        .map_err(|e| format!("{}: {}", file.to_string_lossy(), e))?;
    Ok(backup)
}

/* ---------- Network ---------- */

fn describe(err: ureq::Error) -> String {
    match err {
        ureq::Error::Status(code, _) => format!("The archive answered {}", code),
        ureq::Error::Transport(t) => match t.kind() {
            ureq::ErrorKind::Io => format!("The listing stopped short: {}", t),
            _ => "The archive could not be reached".to_string(),
        },
    }
}

fn fetch_live() -> Result<Vec<Value>, String> {
    let agent = ureq::AgentBuilder::new()
        .user_agent(USER_AGENT)
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(60))
        .build();

    let response = agent.get(LIST_URL).call().map_err(describe)?;
    let mut body = String::new();
    response
        .into_reader()
        .take(MAX_BYTES)
        .read_to_string(&mut body)
        .map_err(|e| format!("The listing stopped short: {}", e))?;

    let doc: Value = serde_json::from_str(&body)
        .map_err(|e| format!("The archive's listing was not readable: {}", e))?;
    doc.get("songs")
        .and_then(|s| s.as_array())
        .cloned()
        .ok_or_else(|| "The archive's listing had no songs".to_string())
}

/* ---------- Commands ---------- */

fn saved_songs(app: &AppHandle) -> (Vec<Value>, String) {
    match data::read_json(app, "catalogue.json") {
        Ok(doc) => (
            doc.get("songs").and_then(|s| s.as_array()).cloned().unwrap_or_default(),
            doc.get("saved_at").and_then(|s| s.as_str()).unwrap_or("").to_string(),
        ),
        Err(_) => (Vec::new(), String::new()),
    }
}

/// Ask the archive what it has and say what differs. Changes nothing.
#[tauri::command]
pub async fn catalogue_check(app: AppHandle, held: State<'_, Held>) -> Result<Report, String> {
    let (rep, live) = tauri::async_runtime::spawn_blocking(move || {
        let live = fetch_live()?;
        let (saved, saved_at) = saved_songs(&app);
        sane(&live, &saved)?;
        Ok::<_, String>((report(&live, &saved, &saved_at), live))
    })
    .await
    .map_err(|e| format!("the check failed: {}", e))??;

    if let Ok(mut slot) = held.0.lock() {
        *slot = Some((Instant::now(), live));
    }
    Ok(rep)
}

/// Write what the last check showed. Refuses a check that is old, so
/// what is written is what was on screen.
#[tauri::command]
pub async fn catalogue_apply(app: AppHandle, held: State<'_, Held>) -> Result<Applied, String> {
    let live = {
        let mut slot = held.0.lock().map_err(|_| "the check could not be read".to_string())?;
        match slot.take() {
            Some((at, live)) if at.elapsed() < HOLD_FOR => live,
            _ => return Err("That check is too old to apply. Check again first.".into()),
        }
    };

    tauri::async_runtime::spawn_blocking(move || {
        let (root, _) = data::resolve(&app);
        if root.as_os_str().is_empty() || !root.is_dir() {
            return Err("There is no archive folder to write the list into.".to_string());
        }
        let (saved, _) = saved_songs(&app);
        sane(&live, &saved)?;

        let diff = compare(&live, &saved);
        let (merged, kept) = fold_covers(live, &saved, &root);
        let covers = if kept > 0 { "local" } else { "remote" };
        let count = merged.len();
        let backup = write_catalogue(&root, merged, covers)?;

        println!(
            "999: catalogue {} records written ({} added, {} removed, {} edited, covers {})",
            count, diff.added.len(), diff.removed.len(), diff.edited.len(), covers
        );
        Ok(Applied {
            count,
            added: diff.added.len(),
            removed: diff.removed.len(),
            edited: diff.edited.len(),
            covers: covers.to_string(),
            backup,
        })
    })
    .await
    .map_err(|e| format!("the update failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(id: &str, title: &str, category: &str, plays: u64, cover: &str) -> Value {
        json!({ "id": id, "title": title, "category": category, "play_count": plays,
                "cover": cover, "alt_names": [] })
    }

    #[test]
    fn matches_on_id_and_ignores_the_two_moving_fields() {
        let saved = vec![
            song("a", "Alpha", "main", 10, "data/covers/aa.webp"),
            song("b", "Bravo", "main", 5, "data/covers/bb.webp"),
            song("c", "Gone", "cut", 1, "x"),
        ];
        let live = vec![
            // only the play count and the cover path moved: not an edit
            song("a", "Alpha", "main", 999, "/cdn/music/covers/a"),
            // a real retitle
            song("b", "Bravo (v2)", "main", 5, "/cdn/music/covers/b"),
            song("d", "Delta", "freestyle", 0, "/cdn/music/covers/d"),
        ];
        let d = compare(&live, &saved);
        assert_eq!(d.added, vec![2]);
        assert_eq!(d.removed, vec![2]);
        assert_eq!(d.edited.len(), 1);
        assert_eq!(d.edited[0].0, 1);
        assert_eq!(d.edited[0].1, vec!["title".to_string()]);

        let r = report(&live, &saved, "then");
        assert_eq!((r.added_total, r.removed_total, r.edited_total, r.retitled_total), (1, 1, 1, 1));
        assert_eq!(r.new_categories, vec!["freestyle".to_string()]);
        assert!(!r.unchanged);
    }

    #[test]
    fn every_edit_is_listed_with_what_changed() {
        let mut a_before = song("a", "Alpha", "main", 1, "c");
        a_before["length"] = json!("3:00");
        a_before["file_size"] = json!("5 MB");
        a_before["file_size_bytes"] = json!(5_000_000);
        let b_before = song("b", "Bravo", "main", 1, "c");
        let saved = vec![a_before, b_before];

        let mut a_now = song("a", "Alpha", "main", 1, "c");
        a_now["length"] = json!("3:10");
        a_now["file_size"] = json!("5.2 MB");
        a_now["file_size_bytes"] = json!(5_200_000);
        let mut b_now = song("b", "Bravo (v2)", "cut", 1, "c");
        b_now["alt_names"] = json!(["Bravo two"]);
        let live = vec![a_now, b_now];

        let r = report(&live, &saved, "then");
        assert_eq!(r.edited_total, 2);
        assert_eq!(r.edited.len(), 2, "every edit is carried, not a few");

        let a = &r.edited[0];
        assert_eq!(a.title, "Alpha");
        assert_eq!(a.was, "", "the title did not move, so there is no old one");
        assert_eq!(a.changes.len(), 2, "the two size fields are one change");
        assert!(a.changes.contains(&"length".to_string()) && a.changes.contains(&"size".to_string()));

        let b = &r.edited[1];
        assert_eq!(b.title, "Bravo (v2)");
        assert_eq!(b.was, "Bravo");
        assert!(b.changes.contains(&"title".to_string()));
        assert!(b.changes.contains(&"category".to_string()));
        assert!(b.changes.contains(&"other names".to_string()));
    }

    #[test]
    fn a_long_listing_is_carried_whole() {
        let saved: Vec<Value> = Vec::new();
        let live: Vec<Value> = (0..300).map(|i| song(&format!("n{}", i), "New", "main", 0, "c")).collect();
        let r = report(&live, &saved, "then");
        assert_eq!(r.added_total, 300);
        assert_eq!(r.added.len(), 300, "no cap on the titles shown");
    }

    #[test]
    fn an_unchanged_listing_says_so() {
        let saved = vec![song("a", "Alpha", "main", 10, "data/covers/aa.webp")];
        let live = vec![song("a", "Alpha", "main", 11, "/cdn/music/covers/a")];
        assert!(report(&live, &saved, "then").unchanged);
    }

    #[test]
    fn a_short_or_broken_listing_is_refused() {
        let saved: Vec<Value> = (0..100).map(|i| song(&format!("id{}", i), "T", "main", 0, "c")).collect();
        assert!(sane(&[], &saved).is_err(), "empty");
        let short: Vec<Value> = saved.iter().take(40).cloned().collect();
        assert!(sane(&short, &saved).is_err(), "under half");
        let mut damaged = saved.clone();
        for s in damaged.iter_mut().take(5) {
            s["id"] = Value::Null;
        }
        assert!(sane(&damaged, &saved).is_err(), "records with no id");
        assert!(sane(&saved, &saved).is_ok());
        let grown: Vec<Value> = (0..120).map(|i| song(&format!("id{}", i), "T", "main", 0, "c")).collect();
        assert!(sane(&grown, &saved).is_ok(), "a bigger listing is fine");
        assert!(sane(&grown, &[]).is_ok(), "nothing saved yet");
    }

    #[test]
    fn a_local_cover_is_kept_only_while_its_file_exists() {
        let root = std::env::temp_dir().join(format!(
            "nine-cat-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(root.join("covers")).unwrap();
        std::fs::write(root.join("covers/here.webp"), b"x").unwrap();

        let saved = vec![
            song("a", "Alpha", "main", 1, "data/covers/here.webp"),
            song("b", "Bravo", "main", 1, "data/covers/missing.webp"),
            song("c", "Charlie", "main", 1, "/cdn/music/covers/c"),
        ];
        let live = vec![
            song("a", "Alpha", "main", 1, "/cdn/music/covers/a"),
            song("b", "Bravo", "main", 1, "/cdn/music/covers/b"),
            song("c", "Charlie", "main", 1, "/cdn/music/covers/c"),
            song("d", "Delta", "main", 1, "/cdn/music/covers/d"),
        ];
        let (out, kept) = fold_covers(live, &saved, &root);
        assert_eq!(kept, 1);
        assert_eq!(out[0]["cover"], "data/covers/here.webp");
        assert_eq!(out[1]["cover"], "/cdn/music/covers/b");
        assert_eq!(out[3]["cover"], "/cdn/music/covers/d");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_write_keeps_a_backup_and_reads_back() {
        let root = std::env::temp_dir().join(format!(
            "nine-cat-w-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("catalogue.json"), r#"{"songs":[{"id":"old"}]}"#).unwrap();

        let backup = write_catalogue(&root, vec![song("a", "Alpha", "main", 1, "c")], "remote").unwrap();
        assert!(backup);
        let now: Value = serde_json::from_str(&std::fs::read_to_string(root.join("catalogue.json")).unwrap()).unwrap();
        assert_eq!(now["count"], 1);
        assert_eq!(now["songs"][0]["id"], "a");
        assert_eq!(now["covers"], "remote");
        let old: Value = serde_json::from_str(&std::fs::read_to_string(root.join("catalogue.json.bak")).unwrap()).unwrap();
        assert_eq!(old["songs"][0]["id"], "old");
        assert!(!root.join("catalogue.json.part").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dates_come_out_right() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(1_000_000_000), "2001-09-09T01:46:40Z");
        assert_eq!(iso_utc(1_700_000_000), "2023-11-14T22:13:20Z");
        // a leap day
        assert_eq!(iso_utc(1_709_164_800), "2024-02-29T00:00:00Z");
    }
}
