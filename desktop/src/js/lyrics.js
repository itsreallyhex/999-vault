/* ============================================================
   Lyrics, the frontend half.

   The lookup, the kept answers and the file fallback are all Rust
   (src-tauri/src/lyrics.rs, command lyrics_get): this module asks it,
   turns the answer into something a screen can draw, and works out
   which line is the current one. It makes no request of its own.

   Used by ambient.js only, and only while the idle screen is up and a
   song is on it. That is the whole of when anything is asked: nothing
   here runs ahead of time or for songs nobody is looking at.
   ============================================================ */

import { invoke, inTauri } from './tauri.js';
import { seconds } from './utils.js';

/** A failed lookup is tried again no sooner than this. */
const OFFLINE_RETRY_MS = 10 * 60 * 1000;
/** A line is "now" this long before its stamp, so the eye lands as the
    voice does. */
const LEAD_S = 0.25;

/** key -> { at, result }. Only answers worth keeping: a song that was
    found, and a failure, for a while. "No lyrics" and "off" are cheap
    to ask Rust again and would go stale if a file was added. */
const memo = new Map();
const inflight = new Map();

export function trackKey(track) {
  return track.rid || `t:${track.t}`;
}

/**
 * LRC text to [{ at, text }], sorted. Understands several stamps on one
 * line, `[mm:ss]`, `[mm:ss.xx]` and `[mm:ss:xx]`, and the `[offset:]`
 * tag; ignores the rest of the metadata tags (`[ar:]`, `[ti:]`).
 */
export function parseLrc(text) {
  const lines = [];
  let offset = 0;

  String(text || '').split(/\r?\n/).forEach((raw) => {
    let rest = raw.trim();
    const stamps = [];
    let m = /^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/.exec(rest);
    while (m) {
      const frac = m[3] ? Number(`0.${m[3]}`) : 0;
      stamps.push(Number(m[1]) * 60 + Number(m[2]) + frac);
      rest = rest.slice(m[0].length);
      m = /^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/.exec(rest);
    }

    if (stamps.length) {
      const words = rest.trim();
      stamps.forEach((at) => lines.push({ at, text: words }));
      return;
    }

    const tag = /^\[offset:\s*([+-]?\d+)\s*\]$/i.exec(raw.trim());
    if (tag) offset = Number(tag[1]) / 1000;
  });

  lines.sort((a, b) => a.at - b.at);
  // A positive offset means the words come sooner (the LRC convention)
  if (offset) lines.forEach((l) => { l.at = Math.max(0, l.at - offset); });
  return lines;
}

/** Index of the line that is current at `sec`, or -1 before the first. */
export function activeIndex(lines, sec) {
  if (!lines || !lines.length) return -1;
  const t = sec + LEAD_S;
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].at <= t) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return found;
}

/** Text with no times to a list of lines, runs of blank lines folded
    into one gap. */
export function plainLines(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach((raw) => {
    const line = raw.replace(/\s+$/, '');
    if (!line && (!out.length || out[out.length - 1] === '')) return;
    out.push(line);
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/** Rust's reply to what the screen needs:
    { state: 'found', source, lines } (timed) or { state: 'found',
    source, plain: [..] }, or { state: 'instrumental' | 'none' | 'off' |
    'offline' }. */
export function shape(reply) {
  if (!reply || typeof reply !== 'object') return { state: 'offline' };

  if (reply.found) {
    const source = reply.source || 'lrclib';
    // Which of the texts LRCLIB had this is, when Rust knows; and why
    // asking for another one did not give one ('only_version', 'busy',
    // 'offline'), so the screen can say so under the words it keeps.
    const extra = {
      version: Number.isFinite(reply.version) ? reply.version : null,
      versions: Number.isFinite(reply.versions) ? reply.versions : null,
      notice: reply.reason || null,
      detail: reply.detail || null
    };
    const timed = reply.synced ? parseLrc(reply.synced) : [];
    if (timed.length) return { state: 'found', source, lines: timed, plain: null, ...extra };

    const raw = reply.plain || (reply.synced || '').replace(/^\s*\[[^\]]*\]/gm, '');
    const plain = plainLines(raw);
    if (plain.length) return { state: 'found', source, lines: null, plain, ...extra };
  }
  if (reply.instrumental) return { state: 'instrumental' };
  // `detail` is what the failed request actually got ("status 503")
  return { state: reply.reason || 'none', detail: reply.detail || null };
}

/**
 * Lyrics for a track, from Rust. Resolves to a shaped answer and never
 * throws. Outside the app (a bare browser) there is no Rust and so no
 * lyrics: that is "off", not an error.
 */
export function fetchLyrics(track, { force = false } = {}) {
  // Nothing to ask with: no app behind the page, or a row saved before
  // records had ids. Not a miss, so it says nothing and offers no retry.
  if (!track || !inTauri || !track.rid) return Promise.resolve({ state: 'skip' });

  // Nothing to look up, and nothing worth sending: an instrumental has
  // no words, and a stem's title is a producer's file name
  // (`JW-BAD ENERGY-mix.1.INSTR_01`), which has no business leaving the
  // machine. Neither is asked about, whatever the setting says.
  if (track.c === 'instrumental') return Promise.resolve({ state: 'instrumental' });
  if (track.c === 'stem') return Promise.resolve({ state: 'skip' });

  const key = trackKey(track);
  const held = memo.get(key);
  // "Try again" skips what was remembered, a failure included
  if (!force && held && (held.result.state === 'found' || Date.now() - held.at < OFFLINE_RETRY_MS)) {
    return Promise.resolve(held.result);
  }
  if (inflight.has(key)) return inflight.get(key);

  // Started inside a promise so that a command which throws before it
  // returns one (a bridge that is not there) is an "offline" like any
  // other failure, not an exception in the caller.
  const args = {
    rid: track.rid,
    title: track.t,
    duration: seconds(track.len) || null,
    // The record's other names, for a title the database does not
    // have. Rust tries at most two, only after the title misses.
    alts: Array.isArray(track.a) ? track.a.slice(0, 4) : []
  };
  if (force) args.force = true;

  const job = Promise.resolve()
    .then(() => invoke('lyrics_get', args))
    .then(shape, () => ({ state: 'offline' }))
    .then((result) => {
      inflight.delete(key);
      if (result.state === 'found' || result.state === 'offline') {
        memo.set(key, { at: Date.now(), result });
      }
      return result;
    });

  inflight.set(key, job);
  return job;
}

/**
 * The next version of a song's lyrics, for "Wrong lyrics? Try another
 * version". LRCLIB often holds several different texts under one name,
 * and nothing in its data says which is the song, so the person chooses:
 * each press moves to the next text and Rust keeps the one it lands on.
 * Resolves to the same shape as fetchLyrics, with `version` and
 * `versions` set, and `notice: 'only_version'` when there is no other.
 * Never throws.
 */
export function fetchOtherVersion(track) {
  if (!track || !inTauri || !track.rid) return Promise.resolve({ state: 'skip' });

  const key = trackKey(track);
  const args = {
    rid: track.rid,
    title: track.t,
    duration: seconds(track.len) || null,
    alts: Array.isArray(track.a) ? track.a.slice(0, 4) : []
  };

  return Promise.resolve()
    .then(() => invoke('lyrics_other_version', args))
    .then(shape, () => ({ state: 'offline' }))
    .then((result) => {
      // What was chosen is what the screen shows from now on
      if (result.state === 'found') memo.set(key, { at: Date.now(), result });
      return result;
    });
}
