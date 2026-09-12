/* ============================================================
   Archive API.

   The only module that talks to the network. Two endpoints are used:
   the catalogue listing, and the cover images it points at.

   It reads the saved copy first. tools/save-catalogue.py writes
   data/catalogue.json from the same endpoint, and when that file is
   there the pages never touch the archive at all. The live request is
   the fallback, and the bundled seed is the fallback after that.
   ============================================================ */

import { API_BASE, REQUEST_TIMEOUT } from './config.js';
import { invoke, loadArchive, resolveAsset } from './tauri.js';

/**
 * Absolute URL for a cover path.
 *
 * The archive hands back `/cdn/music/covers/<id>?v=<hash>`, which needs the
 * API host in front of it. A snapshot saved with `--covers` rewrites that to
 * `data/covers/<id>.webp`, which is served by this site and must be left
 * alone. Anything not under `/cdn/` is therefore treated as ours.
 */
export function coverUrl(path) {
  if (!path) return null;
  if (path.startsWith('/cdn/')) return API_BASE + path;

  // A playlist row saved before covers were stored as paths carries a
  // whole asset URL. Hand those back untouched so old rows keep their
  // artwork instead of being mangled into a path that resolves nowhere.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;

  // A saved catalogue points at `data/covers/<sha1>.webp`, which means
  // nothing to a webview with no server under it. Rust knows where that
  // folder is; resolveAsset turns it into a URL the window can load, and
  // returns null when the covers were never saved, which leaves the
  // generated cover underneath showing through exactly as it does online.
  return resolveAsset(path);
}

/**
 * Convert one API record into the shape the rest of the app uses.
 * Short keys keep the 3,879-row array light to filter and sort over.
 */
export function toTrack(rec) {
  // Fall back to the filename only when there is no title, minus its extension
  const title = rec.title
    || (rec.file_name || '').replace(/\.[a-z0-9]{2,4}$/i, '')
    || 'Untitled';

  return {
    // The archive's own record id. Named `rid` rather than `id`
    // because a saved playlist item already has an `id` of its own,
    // and db.js spreads this shape over the top of it. It is what
    // player.js resolves an audio file through.
    rid: rec.id || null,
    t: title,
    a: (rec.alt_names || []).filter((n) => n && n !== title),
    len: rec.length || '',
    c: rec.category || 'main',
    sz: rec.file_size || '',
    p: rec.play_count || 0,
    d: (rec.archive_added_at || '').slice(0, 10),
    se: Boolean(rec.is_session_edit),
    // The path as the archive or the snapshot gave it, not a resolved
    // URL. db.js stores this shape verbatim, and an asset URL baked in
    // at add-time would point at wherever the archive happened to live
    // that day. Resolution happens when a cover is drawn: coverSrc in
    // covers.js.
    cov: rec.cover || null
  };
}

/**
 * One JSON request with a timeout on it.
 *
 * The timeout matters: without one, a request that hangs rather than
 * fails leaves the page on skeleton cards indefinitely, because the
 * promise never settles and the fallback never runs.
 */
async function getJson(url, timeout, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the track list out of either source. Both carry the same `songs`
    array, because the snapshot stores the records exactly as they arrived. */
function readSongs(payload) {
  const songs = payload?.songs ?? [];
  if (!songs.length) throw new Error('empty response');
  return songs.map(toTrack);
}

/**
 * Load the full catalogue.
 *
 * Resolves to `{ tracks, source, savedAt }`, where `source` is 'saved' or
 * 'live', or rejects so the caller can fall back to the bundled seed.
 *
 * The saved copy is tried first and the archive is only asked when there
 * is no usable snapshot, which is the point of saving one. Pass
 * `{ saved: false }` to force the live request, which is what a refresh
 * would want.
 */
export async function fetchCatalogue({
  timeout = REQUEST_TIMEOUT,
  saved = true
} = {}) {
  if (typeof fetch !== 'function') throw new Error('fetch unavailable');

  // Before anything is turned into a track: coverUrl needs to know where
  // the archive is, and toTrack runs it on every record.
  await loadArchive();

  if (saved) {
    try {
      const snapshot = await invoke('read_catalogue');
      return {
        tracks: readSongs(snapshot),
        source: 'saved',
        savedAt: snapshot?.saved_at || null
      };
    } catch {
      // No snapshot on disk, or the folder is pointed somewhere wrong.
      // Not an error worth surfacing: the archive is right there. Run
      // save-catalogue.py, or fix data_root in src-tauri/config.toml.
    }
  }

  try {
    const payload = await getJson(`${API_BASE}/music/list`, timeout, { mode: 'cors' });
    return { tracks: readSongs(payload), source: 'live', savedAt: null };
  } catch (err) {
    if (err.message === 'timed out') throw new Error('archive timed out');
    throw err;
  }
}
