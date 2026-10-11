//! Lyrics for the idle screen, with as little leaving the machine as the
//! job allows.
//!
//! The order is the owner's: the online lookup is the main source and a
//! file on disk is the fallback.
//!
//!   1. A kept answer. `<archive>/lyrics/<record id>.json`, written the
//!      first time a song is asked about, found or not. A song goes to
//!      the network once. A miss is asked again after a week, since a
//!      leak can be transcribed later, and sooner if the rule for
//!      looking a song up has changed since the miss was written; a hit
//!      never is. "Try again" on the screen asks regardless.
//!   2. The lookup, when the `lyrics` setting is on: a request to
//!      LRCLIB's search for the title and, if that finds nothing, one
//!      each for up to two of the song's other names, stopping at the
//!      first answer. So one request for a song LRCLIB knows by its
//!      title, and at most three for one it does not know at all.
//!   3. A file the person put there: `<audio name>.lrc` or `.txt` beside
//!      the saved song, or the same, or `<record id>.lrc`, in
//!      `<archive>/lyrics/`.
//!
//! **What a request carries, and nothing else**: the song's title, or
//! one of its other names, with every bracketed part taken off it (so
//! `Lucid Dreams (v3) [feat. X]` goes as `Lucid Dreams`: less sent, and
//! the better match), and the artist name, which is the same for
//! everyone. Not the record id, not
//! the length, not the category, no cookie, no referrer, no account, no
//! listening history. The user agent is one fixed word, with no version
//! in it, so it does not tell installs apart. What cannot be hidden is
//! the connection itself: their server sees the machine's IP address,
//! as every website does.
//!
//! **When it is asked**: only when the idle screen is up and a song is on
//! it (the frontend does not call this otherwise), never ahead of time,
//! never for the whole catalogue, never twice for the same song. A failed
//! request is not kept, so a dropped connection is not remembered as "no
//! lyrics".
//!
//! The kept answer is text from a third party's database, on this
//! machine only. The app ships none and passes none on.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use crate::{data, download, paths, settings};

const SEARCH_URL: &str = "https://lrclib.net/api/search";
/// One word, the same for every install and every version.
const USER_AGENT: &str = "999-vault";
/// Every record in the archive is by this artist; it is not read off
/// the record, so it is the same string for everyone.
const ARTIST: &str = "Juice WRLD";
/// How long a "nobody has these" answer is believed. A week: long
/// enough that a song with no lyrics is not asked about every time the
/// screen comes up, short enough that a database gaining it, or a bad
/// answer from a hiccup, does not stick for a month.
const MISS_TTL_SECS: u64 = 7 * 24 * 60 * 60;
/// Which lookup rule wrote a kept miss. A miss written under an older
/// rule says nothing about a newer one (the title-only rule's misses
/// must not stop the other-names step), so it is asked again. Raise it
/// whenever the way a song is looked up changes. 3: the names now come
/// from the catalogue by id, so a miss written when a thin copy of the
/// record was all the page had (title only) is asked again.
const LOOKUP_RULE: u64 = 3;
/// A candidate whose length is further than this from the catalogue's is
/// a different recording. Measured 2026-10-11: 24 of 24 released and 11
/// of 13 main hits were within 6 s.
const MAX_DELTA_SECS: f64 = 12.0;
/// A lyrics file bigger than this is not lyrics.
const MAX_FILE_BYTES: u64 = 512 * 1024;
/// How many of a song's other names are tried after its title misses.
/// Measured 2026-10-11 on the 70 most played unreleased songs: the
/// title alone found 31, the alternate names recovered 14 more, and a
/// looser free-text search recovered none, so that is not built.
const MAX_ALTS: usize = 2;
/// A pause between two requests for the same song.
const BETWEEN_ASKS: Duration = Duration::from_millis(250);

/// What the idle screen gets. Never an error: every way this can go
/// wrong is a reason, because "no lyrics" is an ordinary answer.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Lyrics {
    pub found: bool,
    /// "lrclib" or "file".
    pub source: Option<String>,
    /// LRC text, with `[mm:ss.xx]` stamps.
    pub synced: Option<String>,
    /// Lines with no times.
    pub plain: Option<String>,
    /// LRCLIB says this one has no words.
    pub instrumental: bool,
    /// Why nothing: "none" (asked, nobody has it), "off" (the lookup is
    /// off and there is no file), "offline" (no answer at all: no route,
    /// a timeout, a dropped connection), "busy" (LRCLIB answered, with an
    /// error or with something unusable, after the retries), and
    /// "only_version" (asked for another version and there is none).
    pub reason: Option<String>,
    /// Answered from the kept copy, with no request.
    pub cached: bool,
    /// What the failed request actually got ("status 503", "timed out"),
    /// for whoever is wondering why. Never sent anywhere.
    pub detail: Option<String>,
    /// How many different texts LRCLIB had for this song, when that is
    /// known, and which one this is, counting from 1.
    pub versions: Option<u32>,
    pub version: Option<u32>,
}

impl Lyrics {
    fn nothing(reason: &str) -> Self {
        Lyrics { reason: Some(reason.to_string()), ..Default::default() }
    }
}

/// What a search came back with, once chosen.
#[derive(Debug, PartialEq, Clone)]
struct Pick {
    synced: Option<String>,
    plain: Option<String>,
    instrumental: bool,
}

/// A title as it is sent: every `(...)`, `[...]` and `{...}` taken off,
/// whitespace collapsed, a dangling dash trimmed. A title that is nothing
/// but brackets is sent as it was.
fn clean_title(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut depth: i32 = 0;
    for c in title.chars() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = (depth - 1).max(0),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches(|c: char| c == '-' || c == ' ').to_string();
    if trimmed.is_empty() {
        title.trim().to_string()
    } else {
        trimmed
    }
}

/// What the saved catalogue says about one record.
#[derive(Debug, PartialEq, Clone)]
struct Known {
    title: String,
    /// The record's other names, without the title itself.
    alts: Vec<String>,
    seconds: Option<f64>,
}

/// "3:05" or "1:02:03" to seconds.
fn parse_length(text: &str) -> Option<f64> {
    let parts: Vec<f64> = text
        .trim()
        .split(':')
        .map(|p| p.trim().parse::<f64>().ok())
        .collect::<Option<Vec<f64>>>()?;
    match parts.as_slice() {
        [m, s] => Some(m * 60.0 + s),
        [h, m, s] => Some(h * 3600.0 + m * 60.0 + s),
        _ => None,
    }
}

/// The record out of a parsed catalogue.
fn known_in(catalogue: &serde_json::Value, rid: &str) -> Option<Known> {
    let song = catalogue
        .get("songs")?
        .as_array()?
        .iter()
        .find(|s| s.get("id").and_then(|v| v.as_str()) == Some(rid))?;
    let title = song.get("title")?.as_str()?.to_string();
    let alts = song
        .get("alt_names")
        .and_then(|v| v.as_array())
        .map(|names| {
            names
                .iter()
                .filter_map(|n| n.as_str())
                .filter(|n| !n.trim().is_empty() && *n != title)
                .map(|n| n.to_string())
                .collect()
        })
        .unwrap_or_default();
    let seconds = song.get("length").and_then(|v| v.as_str()).and_then(parse_length);
    Some(Known { title, alts, seconds })
}

/// Whether a kept "nobody has it" is still to be believed: written under
/// the current rule, and recent enough.
fn miss_believed(entry: &serde_json::Value, at: u64) -> bool {
    let rule = entry.get("rule").and_then(|v| v.as_u64()).unwrap_or(1);
    let checked = entry.get("checked").and_then(|v| v.as_u64()).unwrap_or(0);
    rule == LOOKUP_RULE && at.saturating_sub(checked) < MISS_TTL_SECS
}

/// The names to ask under, in order: the title, then up to MAX_ALTS of
/// the song's other names. Each is cleaned the same way, and one that is
/// empty, or the same as one already in the list once punctuation and
/// case are ignored (`Moncler Year (v1.2)` is `Moncler Year`), is left
/// out, so a song is never asked about twice under one name.
fn candidates(title: &str, alts: &[String]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    for raw in std::iter::once(title).chain(alts.iter().map(|a| a.as_str())) {
        let name = clean_title(raw);
        let key = norm(&name);
        if key.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.push(key);
        names.push(name);
        if names.len() > MAX_ALTS {
            break;
        }
    }
    names
}

/// Lowercase letters and digits with single spaces, for comparing titles.
fn norm(text: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in text.chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
            gap = false;
        } else if !gap && !out.is_empty() {
            out.push(' ');
            gap = true;
        }
    }
    out.trim_end().to_string()
}

fn text_of(item: &serde_json::Value, key: &str) -> Option<String> {
    item.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// The time of the last `[mm:ss.xx]` stamp in LRC text, in seconds, or 0
/// when there are none. Tags such as `[ar:Juice WRLD]` do not parse as a
/// time and are skipped.
fn last_stamp(lrc: &str) -> f64 {
    let mut best = 0.0_f64;
    for line in lrc.lines() {
        let mut rest = line.trim_start();
        while rest.starts_with('[') {
            let Some(end) = rest.find(']') else { break };
            if let Some(t) = parse_length(&rest[1..end]) {
                best = best.max(t);
            }
            rest = rest[end + 1..].trim_start();
        }
    }
    best
}

/// LRC text with its stamps taken off, one line after another.
fn strip_stamps(text: &str) -> String {
    text.lines()
        .map(|line| {
            let mut rest = line.trim_start();
            while rest.starts_with('[') {
                match rest.find(']') {
                    Some(end) => rest = rest[end + 1..].trim_start(),
                    None => break,
                }
            }
            rest
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// What the words say, with the stamps, case and punctuation gone, so a
/// timed copy and a plain copy of one text compare as the same, and two
/// uploads of one text collapse into one version.
fn text_key(synced: &Option<String>, plain: &Option<String>) -> String {
    match (synced, plain) {
        (Some(s), _) => norm(&strip_stamps(s)),
        (None, Some(p)) => norm(p),
        _ => String::new(),
    }
}

fn pick_key(p: &Pick) -> String {
    text_key(&p.synced, &p.plain)
}

/// How many different texts are kept for one song at most, the chosen
/// one included.
const MAX_VERSIONS: usize = 5;

/// A search's usable results for this title and length, best first, one
/// per different text.
///
/// Must be by a "juice" artist and carry the title (exactly, or inside a
/// longer one). With a catalogue length to compare, a result more than
/// MAX_DELTA_SECS off is another recording and is dropped.
///
/// The order: an exact title, then one with times, then one whose
/// stamps run for a fair part of the song (a text that ends at 111 s of
/// a 192 s song is a different, shorter piece with this song's name on
/// it, which is how "Anxiety" came to show a skit), then the closest
/// length (within 3 s counts as the same), then the fuller text. LRCLIB
/// holds many uploads of one name, often with the same text, so uploads
/// that say the same thing are one version, not a vote.
fn rank(items: &[serde_json::Value], name: &str, seconds: Option<f64>) -> Vec<Pick> {
    let want = norm(name);
    if want.is_empty() {
        return Vec::new();
    }

    // key, then the text it stands for, then the result
    type Key = (u8, u8, u8, i64, i64, i64, usize);
    let mut found: Vec<(Key, String, Pick)> = Vec::new();

    for (index, item) in items.iter().enumerate() {
        let artist = norm(item.get("artistName").and_then(|v| v.as_str()).unwrap_or(""));
        if !artist.contains("juice") {
            continue;
        }
        let track = norm(item.get("trackName").and_then(|v| v.as_str()).unwrap_or(""));
        let exact = track == want;
        if !exact && !track.contains(&want) {
            continue;
        }

        let synced = text_of(item, "syncedLyrics");
        let plain = text_of(item, "plainLyrics");
        let instrumental = item.get("instrumental").and_then(|v| v.as_bool()).unwrap_or(false);
        if synced.is_none() && plain.is_none() && !instrumental {
            continue;
        }

        let claimed = item.get("duration").and_then(|v| v.as_f64());
        let delta = match (seconds, claimed) {
            (Some(a), Some(b)) => (a - b).abs(),
            _ => 0.0,
        };
        if seconds.is_some() && delta > MAX_DELTA_SECS {
            continue;
        }

        // How much of the song the stamps cover. Plain text has none to
        // judge by and is given the benefit of the doubt.
        let length = seconds.or(claimed).filter(|l| *l > 0.0);
        let span = synced.as_deref().map(last_stamp).filter(|s| *s > 0.0);
        let fit = match (span, length) {
            (Some(s), Some(l)) => (s / l).min(1.0),
            _ => 0.5,
        };

        let key: Key = (
            u8::from(!exact),
            u8::from(synced.is_none()),
            u8::from(fit < 0.5),
            (delta / 3.0).floor() as i64,
            -((fit * 1000.0) as i64),
            (delta * 1000.0) as i64,
            index,
        );
        let text = text_key(&synced, &plain);
        found.push((key, text, Pick { synced, plain, instrumental }));
    }

    found.sort_by(|a, b| a.0.cmp(&b.0));

    // One version per text, the best-ranked upload of each
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<Pick> = Vec::new();
    for (_, text, pick) in found {
        if seen.contains(&text) {
            continue;
        }
        seen.push(text);
        out.push(pick);
        if out.len() >= MAX_VERSIONS {
            break;
        }
    }
    out
}

/// The best of a search's results for this title and length, or None.
fn pick(items: &[serde_json::Value], name: &str, seconds: Option<f64>) -> Option<Pick> {
    rank(items, name, seconds).into_iter().next()
}

/// How a request that came back with nothing usable went wrong. What
/// the screen says depends on it: "LRCLIB is busy" and "no connection"
/// are not the same thing to tell someone who is online.
#[derive(Debug, Clone, Copy, PartialEq)]
enum FailKind {
    /// LRCLIB answered, with an error status or with something that was
    /// not a list. A 503 from a busy server is the usual one.
    Busy,
    /// No answer at all: no route, no name lookup, a timeout, a
    /// connection dropped part way.
    Network,
}

#[derive(Debug, Clone, PartialEq)]
struct Failure {
    kind: FailKind,
    /// What the request actually got, for the screen's small print.
    detail: String,
    /// Worth asking again straight away. A 404 is not; a 503 is.
    retry: bool,
}

impl Failure {
    fn reason(&self) -> &'static str {
        match self.kind {
            FailKind::Busy => "busy",
            FailKind::Network => "offline",
        }
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.detail)
    }
}

enum Ask {
    /// Every different text found, best first (see rank()).
    Hit(Vec<Pick>),
    Miss,
    Failed(Failure),
}

/// How many times one name is asked for before giving up, and how long
/// to wait between. A busy server (429 or 5xx) usually answers the next
/// time; a request that timed out has already cost 8 to 12 seconds, so
/// it gets one more try and no more.
fn attempts_for(kind: FailKind) -> usize {
    match kind {
        FailKind::Busy => 3,
        FailKind::Network => 2,
    }
}
const RETRY_WAITS: [Duration; 2] = [Duration::from_millis(500), Duration::from_millis(1500)];

/// One request. Blocking; the command runs it on a worker thread.
fn ask_once(name: &str) -> Result<Vec<serde_json::Value>, Failure> {
    // No cookie jar (ureq has none unless asked), no referrer, no
    // redirects followed: what is sent is the line and the user agent.
    let agent = ureq::AgentBuilder::new()
        .user_agent(USER_AGENT)
        .timeout_connect(Duration::from_secs(8))
        .timeout_read(Duration::from_secs(12))
        .redirects(0)
        .build();

    let response = agent
        .get(SEARCH_URL)
        .query("track_name", name)
        .query("artist_name", ARTIST)
        .call();

    match response {
        Ok(r) => {
            let body = r.into_string().map_err(|err| Failure {
                kind: FailKind::Network,
                detail: format!("the answer stopped short: {}", err),
                retry: true,
            })?;
            match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(serde_json::Value::Array(items)) => Ok(items),
                _ => Err(Failure {
                    kind: FailKind::Busy,
                    detail: "the answer was not a list".to_string(),
                    retry: true,
                }),
            }
        }
        Err(ureq::Error::Status(code, _)) => Err(Failure {
            kind: FailKind::Busy,
            detail: format!("status {}", code),
            retry: code == 429 || code >= 500,
        }),
        Err(ureq::Error::Transport(t)) => Err(Failure {
            kind: FailKind::Network,
            detail: t.to_string(),
            retry: true,
        }),
    }
}

/// A search for one name, asked again a bounded number of times when it
/// failed in a way that is worth it. The last failure is what comes back.
fn ask_items(name: &str) -> Result<Vec<serde_json::Value>, Failure> {
    let mut tried = 0;
    loop {
        match ask_once(name) {
            Ok(items) => return Ok(items),
            Err(failure) => {
                tried += 1;
                if !failure.retry || tried >= attempts_for(failure.kind) {
                    return Err(failure);
                }
                std::thread::sleep(RETRY_WAITS[(tried - 1).min(RETRY_WAITS.len() - 1)]);
            }
        }
    }
}

/// A name put to LRCLIB: every different text it had, or nothing, or why
/// not.
fn ask(name: &str, seconds: Option<f64>) -> Ask {
    match ask_items(name) {
        Ok(items) => {
            let ranked = rank(&items, name, seconds);
            if ranked.is_empty() {
                Ask::Miss
            } else {
                Ask::Hit(ranked)
            }
        }
        Err(failure) => Ask::Failed(failure),
    }
}

/// Record ids are UUIDs. Anything else never becomes part of a path.
fn valid_rid(rid: &str) -> bool {
    !rid.is_empty()
        && rid.len() <= 64
        && rid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// `<archive>/lyrics`, or the app's own data folder when there is no
/// archive folder on this machine.
fn lyrics_dir(app: &AppHandle) -> Option<PathBuf> {
    let (root, _) = data::resolve(app);
    let base = if root.as_os_str().is_empty() { paths::data_dir(app)? } else { root };
    Some(base.join("lyrics"))
}

fn read_cache(dir: &Path, rid: &str) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(dir.join(format!("{}.json", rid))).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_cache(dir: &Path, rid: &str, entry: &serde_json::Value) {
    // Failing to keep an answer costs one more request next time, so
    // it is not worth an error.
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    if let Ok(text) = serde_json::to_string(entry) {
        let _ = std::fs::write(dir.join(format!("{}.json", rid)), text);
    }
}

fn from_pick(p: &Pick, cached: bool) -> Lyrics {
    Lyrics {
        found: p.synced.is_some() || p.plain.is_some(),
        source: Some("lrclib".to_string()),
        synced: p.synced.clone(),
        plain: p.plain.clone(),
        instrumental: p.instrumental,
        reason: None,
        cached,
        ..Default::default()
    }
}

/// The same, with which version of how many this is.
fn from_pick_version(p: &Pick, cached: bool, version: u32, versions: u32) -> Lyrics {
    Lyrics { version: Some(version), versions: Some(versions), ..from_pick(p, cached) }
}

fn has_text(p: &Pick) -> bool {
    p.synced.is_some() || p.plain.is_some()
}

/// What goes in the kept file: the text being shown (at the top level,
/// where every reader of the file has always looked for it) and the
/// other versions LRCLIB had, so cycling through them needs no request.
/// `version` is the place of the shown one in the ring, counting from 1.
fn entry_for(shown: &Pick, others: &[Pick], version: u32) -> serde_json::Value {
    let others: Vec<serde_json::Value> = others
        .iter()
        .map(|p| serde_json::json!({
            "synced": p.synced,
            "plain": p.plain,
            "instrumental": p.instrumental,
        }))
        .collect();
    serde_json::json!({
        "found": true,
        "source": "lrclib",
        "synced": shown.synced,
        "plain": shown.plain,
        "instrumental": shown.instrumental,
        "checked": now(),
        "version": version,
        "others": others,
    })
}

/// The text a kept file shows.
fn pick_of(entry: &serde_json::Value) -> Pick {
    Pick {
        synced: text_of(entry, "synced"),
        plain: text_of(entry, "plain"),
        instrumental: entry.get("instrumental").and_then(|v| v.as_bool()).unwrap_or(false),
    }
}

/// The other versions a kept file holds, empty for a file written before
/// there were any, or when LRCLIB had one text.
fn others_of(entry: &serde_json::Value) -> Vec<Pick> {
    entry
        .get("others")
        .and_then(|v| v.as_array())
        .map(|list| list.iter().map(pick_of).filter(has_text).collect())
        .unwrap_or_default()
}

/// Which version a kept file shows and how many there are, when it
/// knows. A file from before this has no list, so the count is not known
/// and the screen offers the button, which then asks.
fn versions_of(entry: &serde_json::Value) -> (Option<u32>, Option<u32>) {
    if entry.get("others").and_then(|v| v.as_array()).is_none() {
        return (None, None);
    }
    let total = 1 + others_of(entry).len() as u32;
    let at = entry.get("version").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
    (Some(at.clamp(1, total)), Some(total))
}

/// Whether text carries `[mm:ss` stamps, which is what makes it an LRC.
fn looks_synced(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim_start();
        let mut chars = line.chars();
        chars.next() == Some('[')
            && chars.next().map_or(false, |c| c.is_ascii_digit())
            && line.contains(':')
            && line.contains(']')
    })
}

/// A lyrics file's text as the reply carries it.
fn from_text(text: &str) -> Lyrics {
    let text = text.trim_start_matches('\u{feff}').trim();
    if text.is_empty() {
        return Lyrics::nothing("none");
    }
    let (synced, plain) = if looks_synced(text) {
        (Some(text.to_string()), None)
    } else {
        (None, Some(text.to_string()))
    };
    Lyrics {
        found: true,
        source: Some("file".to_string()),
        synced,
        plain,
        instrumental: false,
        reason: None,
        cached: false,
        ..Default::default()
    }
}

/// The name a saved song has, without its extension, if the index
/// knows it.
fn audio_stem(app: &AppHandle, rid: &str) -> Option<String> {
    let index = data::read_json(app, "audio-index.json").ok()?;
    let file = index.get("by_id")?.get(rid)?.get("file")?.as_str()?;
    Path::new(file).file_stem().map(|s| s.to_string_lossy().to_string())
}

/// A `.lrc` or `.txt` the person put there, looked for by name beside
/// the song and in the lyrics folder.
fn from_file(app: &AppHandle, dir: Option<&Path>, rid: &str, title: &str) -> Option<Lyrics> {
    let (root, _) = data::resolve(app);

    // `<title> [<id8>]`, the name the app gives a saved song, so a file
    // can be named after a song that is not on this machine yet.
    let made = download::safe_name(title, rid, "");
    let made_stem = Path::new(&made).file_stem().map(|s| s.to_string_lossy().to_string());

    let mut names: Vec<String> = Vec::new();
    if let Some(s) = audio_stem(app, rid) { names.push(s); }
    if let Some(s) = made_stem { names.push(s); }
    names.push(rid.to_string());

    let mut bases: Vec<PathBuf> = Vec::new();
    if !root.as_os_str().is_empty() { bases.push(root.join("audio")); }
    if let Some(d) = dir { bases.push(d.to_path_buf()); }

    for base in &bases {
        for name in &names {
            for ext in ["lrc", "txt"] {
                let path = base.join(format!("{}.{}", name, ext));
                let ok = std::fs::metadata(&path).map(|m| m.is_file() && m.len() <= MAX_FILE_BYTES).unwrap_or(false);
                if !ok {
                    continue;
                }
                let bytes = std::fs::read(&path).ok()?;
                let found = from_text(&String::from_utf8_lossy(&bytes));
                if found.found {
                    return Some(found);
                }
            }
        }
    }
    None
}

/// The whole job. See the module comment for the order and the promises.
fn get(app: &AppHandle, rid: &str, title: &str, seconds: Option<f64>, alts: &[String], force: bool) -> Lyrics {
    if !valid_rid(rid) || title.trim().is_empty() {
        return Lyrics::nothing("none");
    }
    let dir = lyrics_dir(app);
    let mut miss_is_fresh = false;

    // 1. A kept answer
    if let Some(d) = &dir {
        if let Some(entry) = read_cache(d, rid) {
            let pick = Pick {
                synced: text_of(&entry, "synced"),
                plain: text_of(&entry, "plain"),
                instrumental: entry.get("instrumental").and_then(|v| v.as_bool()).unwrap_or(false),
            };
            if pick.synced.is_some() || pick.plain.is_some() || pick.instrumental {
                let (version, versions) = versions_of(&entry);
                return Lyrics { version, versions, ..from_pick(&pick, true) };
            }
            // "Try again" ignores a kept miss; a kept hit was returned above
            miss_is_fresh = !force && miss_believed(&entry, now());
        }
    }

    // 2. The lookup
    let mut reason = "none";
    let mut detail: Option<String> = None;
    if !settings::lyrics_on(app) {
        reason = "off";
    } else if !miss_is_fresh {
        // The title first, then, only if that finds nothing, up to two
        // of the song's other names. Unreleased songs circulate under
        // several, and the one the archive uses is often not the one a
        // lyrics database has. It stops at the first answer.
        let mut every_name_missed = true;

        // The record's own name, other names and length, from the saved
        // catalogue by id, not from what the page handed over. The page
        // can hold a thin copy: the Overview's most-played rows, a song
        // resumed from an older launch and a playlist row saved long ago
        // carry an id and a title and nothing else, and "Your Mom (v2)"
        // was asked for under its title alone because of one. What the
        // page sent is the fallback for a record the catalogue lacks.
        let record = data::read_json(app, "catalogue.json").ok().and_then(|c| known_in(&c, rid));
        let (ask_title, ask_alts, ask_seconds) = match &record {
            Some(k) => (
                k.title.clone(),
                if k.alts.is_empty() { alts.to_vec() } else { k.alts.clone() },
                seconds.or(k.seconds),
            ),
            None => (title.to_string(), alts.to_vec(), seconds),
        };

        let names = candidates(&ask_title, &ask_alts);
        for (n, name) in names.iter().enumerate() {
            if n > 0 {
                std::thread::sleep(BETWEEN_ASKS);
            }
            match ask(name, ask_seconds) {
                Ask::Hit(mut picks) => {
                    // The best text is shown; the others are kept
                    // beside it so "another version" needs no request.
                    let best = picks.remove(0);
                    if let Some(d) = &dir {
                        write_cache(d, rid, &entry_for(&best, &picks, 1));
                    }
                    return from_pick_version(&best, false, 1, 1 + picks.len() as u32);
                }
                Ask::Miss => {}
                Ask::Failed(failure) => {
                    // Not kept: a dropped connection or a busy server is
                    // not "nobody has it", and a miss on the first name
                    // proves nothing if the second could not be asked
                    println!("999: lyrics    lookup failed ({})", failure);
                    reason = failure.reason();
                    detail = Some(failure.detail.clone());
                    every_name_missed = false;
                    break;
                }
            }
        }
        if every_name_missed {
            if let Some(d) = &dir {
                // `asked` is for whoever opens the file wondering why:
                // exactly the names that were put to LRCLIB.
                write_cache(d, rid, &serde_json::json!({
                    "found": false,
                    "rule": LOOKUP_RULE,
                    "asked": names,
                    "checked": now(),
                }));
            }
        }
    }

    // 3. A file
    if let Some(found) = from_file(app, dir.as_deref(), rid, title) {
        return found;
    }
    Lyrics { detail, ..Lyrics::nothing(reason) }
}

/// The next version of a song's lyrics, for "Wrong lyrics? Try another
/// version". LRCLIB often holds several different texts under one name
/// (a skit uploaded as the song, a different cut), and nothing in the
/// data says which is right, so the person chooses and the choice is
/// kept.
///
/// A kept answer that carries its other versions turns the ring with no
/// request. One that does not (written before versions were kept, or
/// when LRCLIB had one text) asks again once, keeps what it finds, and
/// then turns. The shown text always moves to the back of the ring, so
/// pressing enough times comes round to where it started.
fn other_version(app: &AppHandle, rid: &str, title: &str, seconds: Option<f64>, alts: &[String]) -> Lyrics {
    if !valid_rid(rid) {
        return Lyrics::nothing("none");
    }
    let Some(dir) = lyrics_dir(app) else { return Lyrics::nothing("none") };
    let Some(entry) = read_cache(&dir, rid) else { return Lyrics::nothing("none") };

    let mut current = pick_of(&entry);
    if !has_text(&current) {
        return Lyrics::nothing("none");
    }
    let mut others = others_of(&entry);
    let mut version = entry.get("version").and_then(|v| v.as_u64()).unwrap_or(1) as u32;

    if others.is_empty() {
        // Nothing kept to turn to. The lookup is the person's to switch
        // off, and that holds here too.
        if !settings::lyrics_on(app) {
            return Lyrics {
                reason: Some("off".into()),
                versions: Some(1),
                version: Some(1),
                ..from_pick(&current, true)
            };
        }

        let record = data::read_json(app, "catalogue.json").ok().and_then(|c| known_in(&c, rid));
        let (ask_title, ask_alts, ask_seconds) = match &record {
            Some(k) => (
                k.title.clone(),
                if k.alts.is_empty() { alts.to_vec() } else { k.alts.clone() },
                seconds.or(k.seconds),
            ),
            None => (title.to_string(), alts.to_vec(), seconds),
        };

        let mine = pick_key(&current);
        let mut failure: Option<Failure> = None;
        for (n, name) in candidates(&ask_title, &ask_alts).iter().enumerate() {
            if n > 0 {
                std::thread::sleep(BETWEEN_ASKS);
            }
            match ask(name, ask_seconds) {
                Ask::Hit(picks) => {
                    others = picks.into_iter().filter(|p| pick_key(p) != mine).collect();
                    break;
                }
                Ask::Miss => {}
                Ask::Failed(f) => {
                    failure = Some(f);
                    break;
                }
            }
        }

        if others.is_empty() {
            let mut out = from_pick_version(&current, true, 1, 1);
            match failure {
                Some(f) => {
                    out.reason = Some(f.reason().to_string());
                    out.detail = Some(f.detail);
                }
                None => out.reason = Some("only_version".to_string()),
            }
            // Remember there is only the one, so the button goes away
            write_cache(&dir, rid, &entry_for(&current, &[], 1));
            return out;
        }
        version = 1;
    }

    // Turn the ring: the shown text goes to the back, the next comes up
    let total = 1 + others.len() as u32;
    others.push(current);
    current = others.remove(0);
    version = if version >= total { 1 } else { version + 1 };
    write_cache(&dir, rid, &entry_for(&current, &others, version));
    from_pick_version(&current, true, version, total)
}

/// Lyrics for one record. Async so the webview is not held while the
/// request is out; the work is blocking I/O on a worker thread.
///
///   rid       the archive's record id
///   title     the record's title, as the catalogue has it
///   duration  its length in seconds, used to choose between recordings
///             and never sent
///   alts      the record's other names, tried one request each after
///             the title misses, at most MAX_ALTS of them
///   force     ask again even if a miss is kept ("Try again")
#[tauri::command]
pub async fn lyrics_get(
    app: AppHandle,
    rid: String,
    title: String,
    duration: Option<f64>,
    alts: Option<Vec<String>>,
    force: Option<bool>,
) -> Lyrics {
    let seconds = duration.filter(|d| d.is_finite() && *d > 0.0);
    let alts = alts.unwrap_or_default();
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || get(&app, &rid, &title, seconds, &alts, force))
        .await
        .unwrap_or_else(|_| Lyrics::nothing("none"))
}

/// The next version of a song's lyrics ("Wrong lyrics? Try another
/// version"). Same arguments as `lyrics_get`, minus `force`. Turns
/// through the versions kept for the song, asking once when none are
/// kept, and keeps the one it lands on.
#[tauri::command]
pub async fn lyrics_other_version(
    app: AppHandle,
    rid: String,
    title: String,
    duration: Option<f64>,
    alts: Option<Vec<String>>,
) -> Lyrics {
    let seconds = duration.filter(|d| d.is_finite() && *d > 0.0);
    let alts = alts.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || other_version(&app, &rid, &title, seconds, &alts))
        .await
        .unwrap_or_else(|_| Lyrics::nothing("none"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn titles_go_out_bare() {
        assert_eq!(clean_title("Lucid Dreams (v3) [feat. Lil Uzi Vert] {Remaster}"), "Lucid Dreams");
        assert_eq!(clean_title("Wake Up! (feat. Juice WRLD)"), "Wake Up!");
        assert_eq!(clean_title("Anxiety - Intro"), "Anxiety - Intro");
        assert_eq!(clean_title("Doom (v3)"), "Doom");
        assert_eq!(clean_title("  Bad   Energy  (v2) "), "Bad Energy");
        // nested, unbalanced and all-brackets titles do not vanish
        assert_eq!(clean_title("A (b (c)) d"), "A d");
        assert_eq!(clean_title("Stuff ((unclosed"), "Stuff");
        assert_eq!(clean_title("(Sessions)"), "(Sessions)");
        assert_eq!(clean_title("Lucid Dreams - (Remix)"), "Lucid Dreams");
    }

    #[test]
    fn other_names_are_tried_but_never_twice_or_many() {
        let alts = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        // the title first, then the other names, cleaned
        assert_eq!(
            candidates("Your Mom (v2)", &alts(&["Scared Of The Dark (v1)", "Mom"])),
            vec!["Your Mom", "Scared Of The Dark", "Mom"]
        );
        // a name that is the title again once cleaned is dropped
        assert_eq!(
            candidates("Moncler Year (v3)", &alts(&["Moncler Year (v1.2)", "MONCLER  YEAR!"])),
            vec!["Moncler Year"]
        );
        // only two other names, however many the record has
        assert_eq!(
            candidates("A", &alts(&["B", "C", "D", "E"])),
            vec!["A", "B", "C"]
        );
        // an empty or blank alternate costs nothing and is skipped
        assert_eq!(candidates("A", &alts(&["", "   ", "B"])), vec!["A", "B"]);
        // no other names: the title, as before
        assert_eq!(candidates("Robbery", &[]), vec!["Robbery"]);
    }

    #[test]
    fn the_record_is_read_from_the_catalogue_not_the_page() {
        let catalogue = json!({ "songs": [
            { "id": "other", "title": "Other", "length": "1:00" },
            { "id": "059356ed", "title": "Your Mom (v2)", "length": "2:24",
              "alt_names": ["Your Mom (v1.1)", "Baked Up", "Ur Mom", "Your Mom (v2)", " "] }
        ]});
        let k = known_in(&catalogue, "059356ed").unwrap();
        assert_eq!(k.title, "Your Mom (v2)");
        assert_eq!(k.seconds, Some(144.0));
        // the title itself and blanks are not other names
        assert_eq!(k.alts, vec!["Your Mom (v1.1)", "Baked Up", "Ur Mom"]);
        // and the ones that get asked, from only a title the page knew
        assert_eq!(candidates(&k.title, &k.alts), vec!["Your Mom", "Baked Up", "Ur Mom"]);

        assert!(known_in(&catalogue, "nope").is_none());
        assert!(known_in(&json!({}), "059356ed").is_none());
        // a record with no other names or length is still a record
        let bare = known_in(&catalogue, "other").unwrap();
        assert!(bare.alts.is_empty() && bare.seconds == Some(60.0));
    }

    #[test]
    fn lengths_parse() {
        assert_eq!(parse_length("3:05"), Some(185.0));
        assert_eq!(parse_length("1:02:03"), Some(3723.0));
        assert_eq!(parse_length(" 0:08 "), Some(8.0));
        assert_eq!(parse_length(""), None);
        assert_eq!(parse_length("soon"), None);
        assert_eq!(parse_length("7"), None);
    }

    #[test]
    fn a_kept_miss_is_believed_only_under_the_rule_that_wrote_it() {
        let day = 24 * 60 * 60;
        let t0 = 1_000_000_000;
        let fresh = json!({ "found": false, "rule": LOOKUP_RULE, "checked": t0 });
        assert!(miss_believed(&fresh, t0 + day));
        // a week on, it is asked again
        assert!(!miss_believed(&fresh, t0 + 8 * day));
        // a miss written before rules existed (the title-only build) says
        // nothing about the other-names step
        let old = json!({ "found": false, "checked": t0 });
        assert!(!miss_believed(&old, t0 + day));
        // and one from some other rule number
        let other = json!({ "found": false, "rule": LOOKUP_RULE + 1, "checked": t0 });
        assert!(!miss_believed(&other, t0 + day));
    }

    #[test]
    fn titles_compare_loosely() {
        assert_eq!(norm("Lean Wit' Me"), "lean wit me");
        assert_eq!(norm("  Ain't   Livin' Right!! "), "ain t livin right");
        assert_eq!(norm("!!!"), "");
    }

    fn item(artist: &str, track: &str, secs: f64, synced: Option<&str>, plain: Option<&str>) -> serde_json::Value {
        json!({
            "artistName": artist, "trackName": track, "duration": secs,
            "syncedLyrics": synced, "plainLyrics": plain, "instrumental": false
        })
    }

    #[test]
    fn the_right_recording_is_chosen() {
        let items = vec![
            item("Someone Else", "Robbery", 240.0, Some("[00:01.00]x"), None),
            item("Juice WRLD", "Robbery (Remix)", 240.0, Some("[00:01.00]remix"), None),
            item("Juice WRLD", "Robbery", 240.0, None, Some("plain words")),
            item("Juice WRLD", "Robbery", 241.0, Some("[00:01.00]timed"), Some("timed plain")),
        ];
        let got = pick(&items, "Robbery", Some(240.0)).unwrap();
        // exact title beats a longer one, and timed beats plain
        assert_eq!(got.synced.as_deref(), Some("[00:01.00]timed"));
        assert!(pick(&items, "Robbery", Some(400.0)).is_none(), "a different length is a different recording");
        // with no length to compare, nothing is dropped for it
        assert!(pick(&items, "Robbery", None).is_some());
        // a contained title still matches when nothing is exact
        let longer = vec![item("Juice WRLD", "Robbery (Official Audio)", 240.0, None, Some("words"))];
        assert_eq!(pick(&longer, "Robbery", Some(238.0)).unwrap().plain.as_deref(), Some("words"));
        // wrong artist, empty name, no text
        assert!(pick(&[item("Drake", "Robbery", 240.0, Some("[00:00.00]x"), None)], "Robbery", None).is_none());
        assert!(pick(&items, "", None).is_none());
        assert!(pick(&[item("Juice WRLD", "Robbery", 240.0, None, None)], "Robbery", None).is_none());
    }

    /// Anxiety, 2026-10-11: nineteen uploads under one name and one
    /// length, eighteen of them the same short text that stops long
    /// before the song does, and one the real song. The first-listed
    /// tie used to win, and the short text was shown.
    #[test]
    fn a_text_that_covers_the_song_beats_one_that_stops_early() {
        let short = "[00:05.00]a\n[00:50.00]b\n[01:51.40]c";
        let full = "[00:12.00]one\n[01:00.00]two\n[02:33.30]three";
        let mut items: Vec<serde_json::Value> = (0..5)
            .map(|_| item("Juice WRLD", "Anxiety", 192.0, Some(short), None))
            .collect();
        items.push(item("Juice WRLD", "Anxiety", 192.0, Some(full), None));

        let ranked = rank(&items, "Anxiety", Some(192.0));
        assert_eq!(ranked.len(), 2, "five uploads of one text are one version");
        assert_eq!(ranked[0].synced.as_deref(), Some(full), "the fuller text comes first");
        assert_eq!(ranked[1].synced.as_deref(), Some(short));
        assert_eq!(pick(&items, "Anxiety", Some(192.0)).unwrap().synced.as_deref(), Some(full));

        // The same two, the other way round in the list: same answer
        items.reverse();
        assert_eq!(pick(&items, "Anxiety", Some(192.0)).unwrap().synced.as_deref(), Some(full));
    }

    #[test]
    fn a_timed_copy_and_a_plain_copy_of_one_text_are_one_version() {
        let items = vec![
            item("Juice WRLD", "Robbery", 240.0, Some("[00:01.00]Hello there\n[00:09.00]Goodbye"), None),
            item("Juice WRLD", "Robbery", 240.0, None, Some("hello there\ngoodbye")),
            item("Juice WRLD", "Robbery", 240.0, None, Some("something else entirely")),
        ];
        let ranked = rank(&items, "Robbery", Some(240.0));
        assert_eq!(ranked.len(), 2);
        assert!(ranked[0].synced.is_some(), "the timed one is the one kept of the pair");
        assert_eq!(ranked[1].plain.as_deref(), Some("something else entirely"));
    }

    #[test]
    fn stamps_are_read_and_tags_are_not() {
        assert_eq!(last_stamp("[ar:Juice WRLD]\n[00:12.50]a\n[01:02.25]b"), 62.25);
        assert_eq!(last_stamp("[00:10.00][02:30.00]chorus\n[00:20.00]x"), 150.0);
        assert_eq!(last_stamp("no stamps here"), 0.0);
        assert_eq!(strip_stamps("[00:10.00][00:11.00]hello\n[00:20.00] world"), "hello world");
    }

    #[test]
    fn a_failure_says_what_it_was() {
        let busy = Failure { kind: FailKind::Busy, detail: "status 503".into(), retry: true };
        let down = Failure { kind: FailKind::Network, detail: "dns".into(), retry: true };
        assert_eq!(busy.reason(), "busy");
        assert_eq!(down.reason(), "offline");
        assert_eq!(busy.to_string(), "status 503");
        // a busy server gets three tries, a request that timed out two
        assert_eq!(attempts_for(FailKind::Busy), 3);
        assert_eq!(attempts_for(FailKind::Network), 2);
    }

    #[test]
    fn a_kept_answer_carries_its_other_versions_and_reads_back() {
        let a = Pick { synced: Some("[00:01.00]a".into()), plain: None, instrumental: false };
        let b = Pick { synced: None, plain: Some("b words".into()), instrumental: false };
        let c = Pick { synced: Some("[00:02.00]c".into()), plain: None, instrumental: false };

        let entry = entry_for(&a, &[b.clone(), c.clone()], 1);
        assert_eq!(pick_of(&entry), a);
        assert_eq!(others_of(&entry), vec![b.clone(), c.clone()]);
        assert_eq!(versions_of(&entry), (Some(1), Some(3)));

        // an old file: the text and nothing about versions
        let old = json!({ "found": true, "source": "lrclib", "synced": "[00:01.00]a", "checked": 5 });
        assert_eq!(versions_of(&old), (None, None));
        assert!(others_of(&old).is_empty());
        assert_eq!(pick_of(&old).synced.as_deref(), Some("[00:01.00]a"));

        // only the one: known to be only the one
        let only = entry_for(&a, &[], 1);
        assert_eq!(versions_of(&only), (Some(1), Some(1)));

        // a version number past the end is held to it
        let odd = entry_for(&a, &[b], 9);
        assert_eq!(versions_of(&odd), (Some(2), Some(2)));
    }

    /// Asks the real LRCLIB, so it is ignored unless named:
    /// `cargo test --lib live_ -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_alt_name_is_found() {
        let alts: Vec<String> = ["Your Mom (v1.1)", "Baked Up", "Ur Mom"].iter().map(|s| s.to_string()).collect();
        let names = candidates("Your Mom (v2)", &alts);
        println!("names asked: {:?}", names);
        let mut hit = false;
        for name in &names {
            match ask(name, Some(144.0)) {
                Ask::Hit(p) => {
                    hit = true;
                    println!("{:?} -> HIT, {} version(s) (best timed: {}, plain: {})",
                        name, p.len(), p[0].synced.is_some(), p[0].plain.is_some());
                }
                Ask::Miss => println!("{:?} -> miss", name),
                Ask::Failed(why) => println!("{:?} -> FAILED: {} ({})", name, why, why.reason()),
            }
            std::thread::sleep(BETWEEN_ASKS);
        }
        assert!(hit, "no name found lyrics");
    }

    /// A song LRCLIB has no lyrics for must come back as a miss, and a
    /// busy server must be retried, not reported as "no connection".
    /// Found 2026-10-11 from a screenshot ("Holes (Remaster)" said
    /// "unavailable without a connection" while the machine was online).
    /// Prints what each request did and how long it took.
    #[test]
    #[ignore]
    fn live_a_plain_miss_is_not_a_failure() {
        let mut failed = Vec::new();
        for round in 0..4 {
            for name in ["Holes", "Lucid Dreams", "Zzzz Not A Song"] {
                let started = std::time::Instant::now();
                let outcome = match ask(name, Some(121.0)) {
                    Ask::Hit(v) => format!("HIT ({} versions)", v.len()),
                    Ask::Miss => "miss".to_string(),
                    Ask::Failed(f) => { failed.push((round, name, f.to_string())); format!("FAILED: {} [{}]", f, f.reason()) }
                };
                println!("round {} {:?} -> {} ({} ms)", round, name, outcome, started.elapsed().as_millis());
                std::thread::sleep(BETWEEN_ASKS);
            }
        }
        assert!(failed.is_empty(), "requests failed even after retrying: {:?}", failed);
    }

    /// The case the ranking was written for, against the real database:
    /// "Anxiety" at 3:12 has many uploads of a short skit and one of the
    /// song, whose chorus the owner supplied. The song must come first,
    /// and the skit must still be there as the other version.
    #[test]
    #[ignore]
    fn live_anxiety_picks_the_real_song() {
        match ask("Anxiety", Some(192.0)) {
            Ask::Hit(versions) => {
                println!("{} versions", versions.len());
                let first = pick_key(&versions[0]);
                assert!(first.contains("bad for the soul"), "the first version is not the song");
                assert!(versions.len() >= 2, "the skit should be kept as another version");
            }
            Ask::Miss => panic!("LRCLIB had nothing for Anxiety"),
            Ask::Failed(f) => panic!("the request failed even after retrying: {}", f),
        }
    }

    #[test]
    fn instrumental_is_an_answer() {
        let mut it = item("Juice WRLD", "Wordless", 100.0, None, None);
        it["instrumental"] = json!(true);
        let got = pick(&[it], "Wordless", Some(100.0)).unwrap();
        assert!(got.instrumental);
        assert!(!from_pick(&got, false).found);
    }

    #[test]
    fn files_are_told_apart() {
        assert!(looks_synced("[ar:x]\n[00:12.30]hello"));
        assert!(looks_synced("  [01:02]hi"));
        assert!(!looks_synced("[Verse 1]\nhello"));
        assert!(!looks_synced("just words\n: and a bracket ]"));

        let timed = from_text("\u{feff}[00:01.00]one\n[00:02.00]two\n");
        assert!(timed.found && timed.synced.is_some() && timed.plain.is_none());
        assert_eq!(timed.source.as_deref(), Some("file"));
        let plain = from_text("one\ntwo");
        assert!(plain.found && plain.plain.is_some() && plain.synced.is_none());
        assert!(!from_text("   \n ").found);
    }

    #[test]
    fn record_ids_cannot_make_paths() {
        assert!(valid_rid("7f32cc12-a785-4e8c-9d5f-3803bdb54d7a"));
        assert!(!valid_rid(""));
        assert!(!valid_rid("../../etc/passwd"));
        assert!(!valid_rid("a b"));
        assert!(!valid_rid(&"a".repeat(65)));
    }

    #[test]
    fn a_kept_answer_round_trips() {
        let dir = std::env::temp_dir().join(format!("nine-lyrics-test-{}", now()));
        write_cache(&dir, "abc-123", &json!({ "found": true, "synced": "[00:01.00]hi", "checked": 5 }));
        let back = read_cache(&dir, "abc-123").unwrap();
        assert_eq!(text_of(&back, "synced").as_deref(), Some("[00:01.00]hi"));
        assert!(read_cache(&dir, "nope").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
