/* ============================================================
   Archive API.

   The only module that talks to the network. Two endpoints are used:
   the catalogue listing, and the cover images it points at.

   It reads the saved copy first. tools/save-catalogue.py writes
   data/catalogue.json from the same endpoint, and when that file is
   there the pages never touch the archive at all. The live request is
   the fallback, and the bundled seed is the fallback after that.
   ============================================================ */

import { API_BASE, REQUEST_TIMEOUT, SNAPSHOT_PATH, SNAPSHOT_TIMEOUT } from './config.js';

/** The saved catalogue, resolved against this module rather than the page,
    so it does not matter which page imported it or what the folder is
    called this week. */
const SNAPSHOT_URL = new URL(SNAPSHOT_PATH, import.meta.url).href;

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
  return path.startsWith('/cdn/') ? API_BASE + path : path;
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
    t: title,
    a: (rec.alt_names || []).filter((n) => n && n !== title),
    len: rec.length || '',
    c: rec.category || 'main',
    sz: rec.file_size || '',
    p: rec.play_count || 0,
    d: (rec.archive_added_at || '').slice(0, 10),
    se: Boolean(rec.is_session_edit),
    cov: coverUrl(rec.cover)
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

  if (saved) {
    try {
      const snapshot = await getJson(SNAPSHOT_URL, SNAPSHOT_TIMEOUT);
      return {
        tracks: readSongs(snapshot),
        source: 'saved',
        savedAt: snapshot?.saved_at || null
      };
    } catch {
      // No snapshot saved yet, or it is unreadable. Not an error worth
      // surfacing: the archive is right there. Run tools/save-catalogue.py
      // if you would rather not depend on it.
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
