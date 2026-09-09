/* ============================================================
   Archive API.

   The only module that talks to the network. Two endpoints are used:
   the catalogue listing, and the cover images it points at. Audio
   endpoints are deliberately not touched anywhere in this project.
   ============================================================ */

import { API_BASE, REQUEST_TIMEOUT } from './config.js';

/** Absolute URL for a cover path returned by the API. */
export function coverUrl(path) {
  return path ? API_BASE + path : null;
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
 * Fetch the full catalogue.
 * Resolves to an array of tracks, or rejects so the caller can fall
 * back to the bundled offline seed.
 *
 * The timeout matters: without one, a request that hangs rather than
 * fails leaves the page on skeleton cards indefinitely, because the
 * promise never settles and the fallback never runs.
 */
export async function fetchCatalogue({ timeout = REQUEST_TIMEOUT } = {}) {
  if (typeof fetch !== 'function') throw new Error('fetch unavailable');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${API_BASE}/music/list`, {
      mode: 'cors',
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const payload = await res.json();
    const songs = payload?.songs ?? [];
    if (!songs.length) throw new Error('empty response');

    return songs.map(toTrack);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('archive timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
