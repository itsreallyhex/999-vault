/* ============================================================
   Playback.

   The only module that owns an <audio> element, in the same way
   api.js owns the network and db.js owns IndexedDB. Both page entry
   points call into it; neither one holds playback logic of its own.

   The archive's records carry an id, and tools/save-audio.py names
   every file `<title> [<id8>].<ext>`. The extension is not fixed:
   2,643 of the saved files are .mp3, 17 are .m4a and 2 are .wav, and
   the title is sanitised for Windows on the way to disk. So a path
   cannot be derived from a title. data/audio-index.json maps record
   id to filename and is the only reliable resolver; it is read once,
   lazily, on the first play.

   Two contexts, deliberately different:

     vault     a loose pile. Ending a track stops. Next is a random
               pick from whatever the grid is currently filtered to,
               minus the 200 most recent. Previous walks back through
               a session-local history stack.
     playlist  a running order. Ending a track advances. Next and
               previous step an index, through a shuffled order when
               shuffle is on.

   The 200-id exclusion queue lives in IndexedDB because it has to
   survive a reload. Volume does not, and lives in localStorage. So
   does the resume snapshot: the app opens on whatever was playing
   when it was closed, at the same position, paused. Under the shell
   the element outlives a page navigation; the snapshot is for the
   shell reloading and for the next launch.
   ============================================================ */

import { API_BASE } from './config.js';
import { invoke, loadArchive, refreshArchive, resolveAudio, inTauri } from './tauri.js';
import { make, clock } from './utils.js';
import { buildCover, coverSpec } from './covers.js';
import { swatchFor } from './ui.js';
import { pushRecent, recentIds, itemsIn, logPlay, addListened } from './db.js';
import { openPicker } from './picker.js';
import {
  createFx, clean as cleanLab, neutral as neutralLab, isNeutral, needsGraph, recall, remember, forget
} from './fx.js';

/* The audio index and the audio folder used to be URLs resolved against
   this module, which worked because a server was serving them. There is
   no server here: Rust reads the index and turns a saved filename into
   an asset URL. See tauri.js. */

/* ---------- Framed by the shell ----------
   shell.html holds the bar and the <audio> element and shows the three
   pages in a same-origin frame, so a navigation inside the frame never
   touches the element and the sound never stops. The shell puts its
   own instance of this module on window.__nine_player; a page that
   finds it there forwards every call to it and mounts nothing of its
   own. Without a shell (a page opened bare, or the jsdom harness) HOST
   is null and this module is the player, exactly as before. */

const HOST = (() => {
  try {
    if (window.parent === window) return null;
    const host = window.parent.__nine_player;
    return host && typeof host.playTrack === 'function' ? host : null;
  } catch {
    // A cross-origin parent throws on access. Not ours, then.
    return null;
  }
})();

/** Volume is a per-viewer convenience, so localStorage is the right
    home for it. Nothing that must be reliable goes here. */
const VOL_KEY = '999:volume';

/** The resume snapshot. localStorage on the desktop, since 2026-09-13:
    the owner wants the app to open on whatever was playing when it
    was closed, at the same position. The site's copy keeps this in
    sessionStorage, scoped to the tab. */
const RESUME_KEY = '999:nowplaying';

/** Set once the shell has restored, and gone when the process is.
    sessionStorage dies with the window in WebView2, so its absence
    is how a cold start is told from a reload of the shell. */
const WARM_KEY = '999:warm';

/**
 * Below this many unplayed tracks in the current filtered set, the
 * exclusion queue is ignored for that pick.
 *
 * Without it a narrow filter locks up: `remaster` is 44 records, so a
 * 200-id queue can swallow the whole category and leave nothing to
 * choose from. Falling back to the full filtered pool repeats a track
 * sooner, which is better than a dead button.
 */
const MIN_FRESH = 12;

/** How often the resume snapshot is written while playing, in ms.
    Every timeupdate would be four writes a second; once a second is
    what makes the position on the next launch the position at the
    close, give or take under a second. */
const RESUME_EVERY = 1000;

/* ---------- Audio index ---------- */

let indexPromise = null;
/** record id -> filename */
const byId = new Map();
/** normalised title -> record id, for playlist items saved before
    records carried an id. Built from the filenames, which embed the
    title ahead of the ` [id8]` suffix, so it costs no extra file. */
const byTitle = new Map();

function normalise(title) {
  return String(title || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Read the audio index, once.
 *
 * A missing index is not an error: it means the songs were never
 * pulled, and the player says so rather than throwing. The file is
 * gitignored and rebuilt by tools/save-audio.py.
 */
function loadIndex() {
  if (indexPromise) return indexPromise;

  // loadArchive is in here rather than left to the entry point. The
  // Vault gets it for free because api.js calls it while fetching the
  // catalogue, but playlists.js never reads the archive at all, so on
  // that page the root stayed null and resolveAudio returned null for
  // every track: the bar said "Not saved to this machine" for files
  // that were sitting right there. The module that needs the path is
  // the one that should make sure it has it.
  indexPromise = Promise.all([loadArchive(), invoke('read_audio_index')])
    .then(([, payload]) => {
      const rows = payload && payload.by_id ? payload.by_id : {};

      Object.keys(rows).forEach((id) => {
        const file = rows[id] && rows[id].file;
        if (!file) return;
        byId.set(id, file);

        // "10 Feet (Sessions) [7f32cc12].mp3" -> "10 feet (sessions)"
        const stem = file.replace(/\s*\[[0-9a-f]{8}\]\.[^.]+$/i, '');
        const key = normalise(stem);
        if (key && !byTitle.has(key)) byTitle.set(key, id);
      });

      return true;
    })
    .catch(() => false);

  return indexPromise;
}

/** The record id for a track, falling back to its title only for
    playlist items saved before `rid` existed. A track that has a rid
    and is not in the index is not on disk, full stop: matching it by
    title would hand an instrumental the main track's file. */
function ridFor(track) {
  if (!track) return null;
  if (track.rid) return byId.has(track.rid) ? track.rid : null;
  return byTitle.get(normalise(track.t)) || null;
}

/** Whether a track has a file on disk. Keeps the random pool to
    things that can actually play. */
export function hasAudio(track) {
  if (HOST) return HOST.hasAudio(track);
  return Boolean(ridFor(track));
}

function srcFor(track) {
  const rid = ridFor(track);
  return rid ? resolveAudio(byId.get(rid)) : null;
}

/**
 * The archive's own stream for a track, for when there is no file here.
 *
 * `/music/stream/<id>` is a plain, stable, unsigned URL: 206 on a Range
 * request, CORS reflects the origin, no token, no cookie, and a request
 * to it leaves the download allowance untouched, which is what makes it
 * the right endpoint for playback and the wrong one for the archiver.
 * `/music/download/` is the metered one, at 500 a day anonymous, and it
 * sends a Content-Disposition and 500s on three records. Do not switch
 * this to it.
 *
 * Needs the record id, so a playlist row saved before `rid` existed
 * cannot use this and lands in the plain missing state.
 */
function apiSrcFor(track) {
  return track && track.rid
    ? `${API_BASE}/music/stream/${encodeURIComponent(track.rid)}`
    : null;
}

/** How long to wait on the archive before calling a stream dead. The
    element fires `error` on a 404 or a refused connection, but a
    connection that hangs never settles on its own, and a bar that says
    a track is playing while nothing arrives is the one state this must
    never end in. */
const API_TIMEOUT = 20000;
let apiTimer = null;

function clearApiTimer() {
  if (apiTimer) clearTimeout(apiTimer);
  apiTimer = null;
}

/** Whether the current load meant to play. apiFailed() needs it to
    know whether to start the fallback file or leave it paused. */
let wantPlay = true;

/** The archive did not deliver. With the file on disk (stream-first
    mode, since local-first never streams a track it has) carry on from
    that, picking up where the stream got to; otherwise the missing
    state, and never a bar that looks like it is about to play. */
function apiFailed(reason) {
  clearApiTimer();

  const local = state.track ? srcFor(state.track) : null;
  if (local) {
    const at = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    state.source = 'local';
    audio.src = local;
    if (at > 0) {
      audio.addEventListener('loadedmetadata', () => { audio.currentTime = at; }, { once: true });
    }
    paintOrigin();
    ui.status.textContent = `${state.track.t}: the archive did not answer, playing the saved file`;
    notify();
    if (wantPlay) audio.play().catch(() => {});
    return;
  }

  audio.pause();
  audio.removeAttribute('src');
  ui.bar.classList.add('is-missing');
  ui.range.disabled = true;
  ui.origin.hidden = true;
  ui.sub.textContent = reason;
  if (state.track) ui.status.textContent = `${state.track.t}: ${reason}`;
  paintPlaying(false);
}

/* ---------- Settings ----------
   What the Settings page changes, mirrored here so load() and
   presenceSync() do not ask Rust on every call. Loaded once in
   initPlayer() from settings_get; the page calls applySettings() when
   it saves, which lands on the host under the shell. Defaults match
   the Rust side: local first, Discord on. */

const prefs = {
  /** 'local': the file if there is one, else the stream. 'stream':
      the archive, and the file only if the archive fails. */
  source: 'local',
  discord: true,
  /** The idle screen: whether it may come up by itself, and after how
      many seconds with no input. ambient.js reads these through
      onSettings(); the player only carries them. */
  idle: true,
  idleSeconds: 30,
  /** Seconds of overlap between one song and the next. 0 is off. */
  crossfade: 0
};

/** Told when a setting changes, with the whole block. */
const settingsListeners = new Set();

function loadSettings() {
  if (!inTauri) return Promise.resolve();
  return invoke('settings_get')
    .then((s) => applySettings({
      source: s.source,
      discord: s.discord,
      idle: s.idle,
      idleSeconds: s.idle_seconds,
      crossfade: s.crossfade
    }))
    .catch(() => { /* not under Tauri, or no config: defaults stand */ });
}

/** Be told when a setting changes, and once straight away. Returns the
    unsubscribe. */
export function onSettings(fn) {
  if (HOST) return HOST.onSettings(fn);
  settingsListeners.add(fn);
  try { fn({ ...prefs }); } catch { /* a listener must not break the player */ }
  return () => settingsListeners.delete(fn);
}

/** Take new values. Source applies from the next load; Discord off
    clears the presence now. */
export function applySettings(next = {}) {
  if (HOST) { HOST.applySettings(next); return; }
  if (next.source === 'local' || next.source === 'stream') prefs.source = next.source;
  if (typeof next.idle === 'boolean') prefs.idle = next.idle;
  if (Number.isFinite(next.idleSeconds) && next.idleSeconds >= 5) prefs.idleSeconds = Math.round(next.idleSeconds);
  if (Number.isFinite(next.crossfade) && next.crossfade >= 0) {
    prefs.crossfade = Math.min(12, Math.round(next.crossfade));
  }
  settingsListeners.forEach((fn) => {
    try { fn({ ...prefs }); } catch { /* as above */ }
  });
  if (typeof next.discord === 'boolean') {
    const was = prefs.discord;
    prefs.discord = next.discord;
    if (was && !next.discord && inTauri) {
      clearTimeout(presenceTimer);
      presenceTimer = null;
      invoke('presence_clear').catch(() => {});
    }
    if (!was && next.discord) presenceSync();
  }
}

/** A copy, for the page to draw. */
export function settings() {
  if (HOST) return HOST.settings();
  return { ...prefs };
}

/* ---------- State ---------- */

const state = {
  track: null,
  context: 'vault',
  playlistId: null,
  /** Playlist context: the items, in playlist order. */
  list: [],
  /** Indices into `list`, sequential or shuffled. Stepping this rather
      than re-rolling on every next is what stops shuffle handing back
      a track it has already been through. */
  order: [],
  cursor: -1,
  shuffle: false,
  repeat: 'off',
  /** Vault context only: tracks already played, newest last. */
  history: [],
  /** Tracks asked for next, in order, ahead of whatever the context
      would pick, each as { qid, track }. The id is what lets the same
      song sit in the queue twice and still be taken out one at a
      time. Served by next() and by a track ending; the context and
      its cursor are left alone so the running order carries on
      afterwards. Session state, like shuffle: not in the resume. */
  queue: [],
  /** True while the loaded track came out of the queue rather than the
      running order, so the bar does not claim a position it does not
      have. */
  fromQueue: false,
  /** Vault only: the random song Next will play, picked early so the
      Up next panel can say what it is. Next uses it and clears it. */
  peek: null,
  /** 'local' for a file on this machine, 'api' for the archive's stream,
      null when there is neither. Drives the visible label in the bar. */
  source: null
};

/** The 200 most recent ids, mirrored in memory so a random pick does
    not have to await a database read. The database is the record of
    it; this is a copy that follows. */
let recent = new Set();

/** What the Vault grid is currently showing. app.js registers its own
    `visible()`, so filter and sort stay owned by app.js and this
    module never learns what a chip or a search box is. */
let vaultPool = () => [];

export function setVaultPool(fn) {
  if (HOST) { HOST.setVaultPool(fn); return; }
  if (typeof fn === 'function') vaultPool = fn;
}

/* ---------- Listening history ----------
   One row in `plays` per track started, and the seconds actually
   heard added to it as they pass. The overview on index.html is
   drawn from nothing else. */

/** The `plays` row for the loaded track, once logPlay has answered. */
let playId = null;
/** True from the first play of a loaded track until its row exists,
    so a second play event cannot log the same start twice. */
let logging = false;
/** Where the element was at the last timeupdate, to turn a stream of
    positions into seconds heard. */
let lastPos = 0;
/** Seconds heard that have not reached the database yet. */
let unflushed = 0;

/**
 * Turn the element's position into seconds heard.
 *
 * Only a small forward step counts. A seek is a large one, a restart
 * is a negative one, and neither is listening. So a drag on the seek
 * bar moves the position without inventing time.
 */
function tick() {
  const pos = audio.currentTime || 0;
  const step = pos - lastPos;
  if (step > 0 && step < 2) unflushed += step;
  lastPos = pos;
}

/** Write the seconds heard so far. Called on a timer while playing
    and at every boundary: pause, end, track change, navigation. */
function flushListened() {
  if (!playId || unflushed < 0.5) return;
  const seconds = unflushed;
  unflushed = 0;
  addListened(playId, seconds).catch(() => {
    // Storage refused. The seconds are gone; the play itself stands.
  });
}

/** A track has started making sound for the first time since it was
    loaded: give it a row. Seconds ticked while the row was in flight
    wait in `unflushed` and land on the next flush. */
function logStart() {
  if (playId || logging || !state.track) return;
  logging = true;
  logPlay(state.track)
    .then((id) => { playId = id; })
    .catch(() => {})
    .finally(() => { logging = false; });
}

/* ---------- Audio element ---------- */

/* Two elements, one of them idle. `audio` is always the one the bar
   speaks for; `spare` waits. They only trade places for a crossfade:
   the next song starts on the idle one while the old one fades, and
   then the roles are simply the other way round. Everything below
   reads `audio`, so every handler works unchanged on whichever it is;
   the handlers that are bound to both ignore an event that is not
   from the live one. */
let audio = new Audio();
audio.preload = 'metadata';
let spare = null;

/** The volume the person chose, 0 to 1. A fade moves each element's own
    volume around it, so the chosen level is kept here. */
let level = 0.8;

/** Read the saved volume before the first track, so the first play is
    not full blast. A private window can refuse storage outright. */
try {
  const saved = parseFloat(localStorage.getItem(VOL_KEY));
  level = Number.isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 0.8;
} catch {
  level = 0.8;
}
audio.volume = level;

/* ---------- Watchers ----------
   The pages draw their own "now playing" mark on the row or card that
   holds the loaded track, and they need telling when that changes.
   This is the whole of it: a set of callbacks, told on every track
   change and every play or pause. Nothing here knows what a row is. */

const watchers = new Set();

function snapshot() {
  return {
    track: state.track,
    playing: Boolean(state.track) && !audio.paused,
    context: state.context,
    playlistId: state.playlistId,
    source: state.source
  };
}

function notify() {
  const now = snapshot();
  watchers.forEach((fn) => {
    try { fn(now); } catch { /* a page's mark must not take the player down */ }
  });
}

/**
 * Be told whenever the loaded track or the playing state changes.
 *
 * Called once straight away with the current state, so a page that
 * subscribes after a resume marks the right row without waiting for
 * the next event. Returns the unsubscribe.
 */
export function onPlayback(fn) {
  if (HOST) {
    // The callback belongs to this page. Let go of it on the way out,
    // so the shell is not left calling into a document that has gone.
    const off = HOST.onPlayback(fn);
    window.addEventListener('pagehide', off, { once: true });
    return off;
  }
  watchers.add(fn);
  fn(snapshot());
  return () => watchers.delete(fn);
}

/**
 * Whether two track objects are the same record.
 *
 * A Vault card carries the archive's `rid`; a playlist row carries
 * that plus its own `id`; a row saved before `rid` existed carries
 * only the `id` and the title; a resumed track is a JSON copy of
 * whichever it was. So: the record id when both have one, then the
 * row id, then the title, which is what the audio index falls back
 * to as well.
 */
export function sameTrack(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.rid && b.rid) return a.rid === b.rid;
  if (a.id && b.id) return a.id === b.id;
  return normalise(a.t) === normalise(b.t);
}

/* ---------- Discord presence ----------
   What the bar shows, on the owner's Discord profile too. Rust carries
   it down the local pipe (presence.rs); this decides what goes.

   Playing: the title, "Juice WRLD", the cover, and start plus end
   timestamps so Discord draws its bar with elapsed and total. With
   repeat-one on, the second line reads "Juice WRLD · On repeat". The
   category and the playlist position used to be on that line and were
   taken off at the owner's request: where a track came from is not
   something a profile needs to say. Paused: no end, the start set to the moment of the pause,
   and the second line "Paused", so Discord shows a timer counting up
   from when it stopped. Nothing loaded, or the track ended: cleared.

   The cover is the one thing that cannot come from disk. Discord's own
   servers fetch the image, so it has to be a URL, and the archive's CDN
   keys covers by record id, which every track here carries. A row
   saved before `rid` existed has no URL and shows the app's icon.

   Updates are coalesced: Discord rate-limits activity changes, and a
   drag on the seek bar fires seeked many times a second. */

const COVER_CDN = `${API_BASE}/cdn/music/covers/`;
const PRESENCE_WAIT = 400;
let presenceTimer = null;
/** When the current pause began, for the count-up. */
let pausedAt = 0;

function presenceShown() {
  const track = state.track;
  if (!track || !audio.getAttribute('src') || audio.ended) return null;

  const now = Math.floor(Date.now() / 1000);
  const shown = {
    title: track.t,
    line: '',
    image: track.rid ? COVER_CDN + encodeURIComponent(track.rid) : null,
    start: null,
    end: null
  };

  if (audio.paused) {
    shown.line = 'Paused';
    shown.start = Math.floor((pausedAt || Date.now()) / 1000);
    return shown;
  }

  shown.line = state.repeat === 'one' ? 'Juice WRLD · On repeat' : 'Juice WRLD';

  // Wall-clock time, so a song at 0.85x takes longer than its length
  // and Discord's bar still ends when the sound does
  const rate = audio.playbackRate > 0 ? audio.playbackRate : 1;
  const pos = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  shown.start = now - Math.floor(pos / rate);
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    shown.end = shown.start + Math.round(audio.duration / rate);
  }
  return shown;
}

function presencePush() {
  presenceTimer = null;
  if (!inTauri) return;
  const shown = presenceShown();
  const call = shown ? invoke('presence_set', { shown }) : invoke('presence_clear');
  call.catch(() => {
    // Discord is not there, or the pipe closed. Nothing else cares.
  });
}

/** Ask for an update soon. Repeated asks collapse into one. */
function presenceSync() {
  if (!inTauri || HOST || !prefs.discord) return;
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(presencePush, PRESENCE_WAIT);
}

/* ---------- Elements ---------- */

const ui = {};
let mounted = false;

const NS = 'http://www.w3.org/2000/svg';

/** One icon, from one or more path commands. SVG needs createElementNS;
    the same helper playlists.js uses, widened to several paths. */
function icon(...ds) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  ds.forEach((d) => {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  });
  return svg;
}

/** A filled icon, for the shapes that read badly as outlines. */
function solid(d) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  return svg;
}

const PLAY = 'M8 5.14v13.72a1 1 0 0 0 1.5.86l11.14-6.86a1 1 0 0 0 0-1.72L9.5 4.28A1 1 0 0 0 8 5.14z';
const PAUSE = 'M7 4h3.4v16H7zM13.6 4H17v16h-3.4z';
const PREV = 'M6 5h2.2v14H6zM20 5.9v12.2a1 1 0 0 1-1.53.85l-9.76-6.1a1 1 0 0 1 0-1.7l9.76-6.1A1 1 0 0 1 20 5.9z';
const NEXT = 'M15.8 5H18v14h-2.2zM4 5.9v12.2a1 1 0 0 0 1.53.85l9.76-6.1a1 1 0 0 0 0-1.7L5.53 5.05A1 1 0 0 0 4 5.9z';
const SHUFFLE = ['M16 3h5v5', 'M21 3l-6.5 6.5', 'M21 16v5h-5', 'M14.5 14.5L21 21', 'M3 3l6.5 6.5', 'M3 21l7-7'];
const REPEAT = ['M17 2l4 4-4 4', 'M3 11v-1a4 4 0 0 1 4-4h14', 'M7 22l-4-4 4-4', 'M21 13v1a4 4 0 0 1-4 4H3'];
const VOL = ['M11 5L6 9H2v6h4l5 4V5z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M18.5 5.5a9 9 0 0 1 0 13'];
const MUTE = ['M11 5L6 9H2v6h4l5 4V5z', 'M22 9l-6 6', 'M16 9l6 6'];
const CROSS = 'M6 6l12 12M18 6L6 18';
const SAVE = ['M12 4v11', 'M7 10l5 5 5-5', 'M4 19h16'];
const PLUS = ['M12 5v14', 'M5 12h14'];
/** Four corner brackets: open the full-window now playing screen. */
const EXPAND = ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'];
/** Three lines and a play mark: the queue. */
const LIST = ['M4 6h12', 'M4 12h12', 'M4 18h7', 'M17 14l4 3-4 3z'];
/** Three sliders: the sound lab. */
const SLIDERS = ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'];
/** A crescent: the sleep timer. */
const MOON = 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z';

/** An icon-only button, labelled for anyone not looking at it. */
function control(cls, label, svg) {
  const btn = make('button', cls);
  btn.type = 'button';
  btn.setAttribute('aria-label', label);
  btn.appendChild(svg);
  return btn;
}

/**
 * Build the bar and put it on the page.
 *
 * The markup is built here rather than sitting in vault.html and
 * playlists.html, so the two pages cannot drift apart and a new page
 * gets the player by importing this module. It starts hidden and
 * slides in on the first play.
 */
function mount() {
  if (mounted) return;
  mounted = true;

  const bar = make('section', 'mini');
  bar.id = 'mini';
  bar.setAttribute('aria-label', 'Now playing');
  bar.hidden = true;

  // The tint under the bar, painted from the playing track's own
  // palette. Its own layer, so the strength is an opacity rather than
  // a colour function an older engine might not know.
  bar.appendChild(make('span', 'mini-wash'));

  /* ---- Identity ---- */
  const who = make('div', 'mini-who');

  // A button: pressing the artwork opens the record in the Vault.
  // The shell listens for the event; a bare page ignores it.
  ui.shot = make('button', 'mini-shot');
  ui.shot.type = 'button';
  ui.shot.setAttribute('aria-label', 'Show this track in the Vault');
  who.appendChild(ui.shot);

  const text = make('span', 'mini-text');
  ui.title = make('span', 'mini-title');
  ui.sub = make('span', 'mini-sub');
  // Plain text, not an icon: it has to be obvious at a glance that this
  // track is coming over the network rather than from disk.
  ui.origin = make('span', 'mini-origin', 'via API');
  ui.origin.hidden = true;
  // One line of feedback for the buttons on the right: saving,
  // saved, or why not. Clears itself.
  ui.note = make('span', 'mini-note');
  ui.note.hidden = true;
  text.appendChild(ui.title);
  text.appendChild(ui.sub);
  text.appendChild(ui.origin);
  text.appendChild(ui.note);
  who.appendChild(text);

  // Three bars that move while the audio does. Purely a state cue,
  // hidden from the tree and stilled under reduced motion.
  ui.eq = make('span', 'mini-eq');
  ui.eq.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) ui.eq.appendChild(make('i'));
  who.appendChild(ui.eq);

  bar.appendChild(who);

  /* ---- Transport ---- */
  const mid = make('div', 'mini-mid');
  const row = make('div', 'mini-row');

  ui.shuffle = control('mini-btn mini-toggle', 'Shuffle', icon(...SHUFFLE));
  ui.shuffle.setAttribute('aria-pressed', 'false');
  ui.prev = control('mini-btn', 'Previous track', solid(PREV));
  ui.play = control('mini-play', 'Play', solid(PLAY));
  ui.next = control('mini-btn', 'Next track', solid(NEXT));
  ui.repeat = control('mini-btn mini-toggle', 'Repeat: off', icon(...REPEAT));
  ui.repeat.setAttribute('aria-pressed', 'false');
  ui.repeat.dataset.mode = 'off';
  // The "1" that tells repeat-one from repeat-all. A badge rather than
  // a second icon, so the control does not change shape as it cycles.
  ui.repeat.appendChild(make('span', 'mini-badge', '1'));

  [ui.shuffle, ui.prev, ui.play, ui.next, ui.repeat]
    .forEach((btn) => row.appendChild(btn));
  mid.appendChild(row);

  /* ---- Seek ---- */
  const seek = make('div', 'mini-seek');

  ui.now = make('span', 'mini-time mono', '0:00');

  // 0..1000 rather than 0..duration: the duration is not known until
  // metadata lands, and a thousand steps is finer than the bar is wide.
  ui.range = make('input', 'mini-range');
  ui.range.type = 'range';
  ui.range.min = '0';
  ui.range.max = '1000';
  ui.range.value = '0';
  ui.range.step = '1';
  ui.range.disabled = true;
  ui.range.setAttribute('aria-label', 'Seek');

  ui.end = make('span', 'mini-time mono', '0:00');

  seek.appendChild(ui.now);
  seek.appendChild(ui.range);
  seek.appendChild(ui.end);
  mid.appendChild(seek);

  bar.appendChild(mid);

  /* ---- Add, save, volume and dismiss ---- */
  const side = make('div', 'mini-side');

  ui.add = control('mini-btn mini-add', 'Add to a playlist', icon(...PLUS));
  ui.add.hidden = true;
  side.appendChild(ui.add);

  // Shown only for a track that is not on this machine. Hidden, not
  // disabled, once it is: there is nothing left for it to do.
  ui.save = control('mini-btn mini-save', 'Save to this machine', icon(...SAVE));
  ui.save.hidden = true;
  side.appendChild(ui.save);

  // The idle screen, now, without waiting for it. Only the shell has
  // that screen; a bare page raises the event and nothing listens.
  ui.screen = control('mini-btn mini-screen', 'Open the now playing screen', icon(...EXPAND));
  ui.screen.title = 'Now playing screen';
  ui.screen.hidden = true;
  side.appendChild(ui.screen);

  // Three that open a panel over the bar. The player only raises an
  // event naming the button; the shell owns the panels, the same split
  // the artwork and the screen button use.
  ui.queueBtn = control('mini-btn mini-queue', 'Up next', icon(...LIST));
  ui.queueBtn.title = 'Up next';
  ui.queueN = make('span', 'mini-count', '0');
  ui.queueN.hidden = true;
  ui.queueBtn.appendChild(ui.queueN);
  side.appendChild(ui.queueBtn);

  ui.lab = control('mini-btn mini-lab', 'Sound lab', icon(...SLIDERS));
  ui.lab.title = 'Sound lab';
  side.appendChild(ui.lab);

  ui.sleep = control('mini-btn mini-sleep', 'Sleep timer', icon(MOON));
  ui.sleep.title = 'Sleep timer';
  ui.sleepN = make('span', 'mini-count', '');
  ui.sleepN.hidden = true;
  ui.sleep.appendChild(ui.sleepN);
  side.appendChild(ui.sleep);

  ui.mute = control('mini-btn mini-vol-btn', 'Mute', icon(...VOL));
  side.appendChild(ui.mute);

  ui.volume = make('input', 'mini-range mini-volume');
  ui.volume.type = 'range';
  ui.volume.min = '0';
  ui.volume.max = '100';
  ui.volume.step = '1';
  ui.volume.value = String(Math.round(level * 100));
  ui.volume.setAttribute('aria-label', 'Volume');
  side.appendChild(ui.volume);

  ui.close = control('mini-btn mini-close', 'Stop and hide the player', icon(CROSS));
  side.appendChild(ui.close);

  bar.appendChild(side);

  /* ---- Announcements ----
     The title is not itself a live region: it would read out on every
     redraw. This says the one thing worth saying. */
  ui.status = make('p', 'sr-only');
  ui.status.setAttribute('role', 'status');
  ui.status.setAttribute('aria-live', 'polite');
  bar.appendChild(ui.status);

  document.body.appendChild(bar);
  ui.bar = bar;

  wire();
  paintVolume();
}

/* ---------- Painting ---------- */

/** Fill a range's track up to its value. The gradient reads the
    percentage off a custom property, so painting is one number. */
function fill(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--p', `${pct}%`);
}

function paintVolume() {
  // `level`, not the element: mid-fade the element's own volume moves
  const muted = audio.muted || level === 0;
  ui.mute.textContent = '';
  ui.mute.appendChild(icon(...(muted ? MUTE : VOL)));
  ui.mute.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  ui.bar.classList.toggle('is-muted', muted);
  fill(ui.volume);
}

function paintPlaying(playing) {
  ui.play.textContent = '';
  ui.play.appendChild(solid(playing ? PAUSE : PLAY));
  ui.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  ui.bar.classList.toggle('is-playing', playing);
  notify();
  presenceSync();
}

/** mm:ss, or a dash while the duration is still unknown. */
function stamp(value) {
  return Number.isFinite(value) && value >= 0 ? clock(value) : '-:--';
}

function paintTimes() {
  ui.now.textContent = stamp(audio.currentTime);
  // Until metadata lands, the catalogue's own "3:16" is a better
  // answer than a dash, and it is usually right.
  ui.end.textContent = Number.isFinite(audio.duration) && audio.duration > 0
    ? clock(audio.duration)
    : ((state.track && state.track.len) || '-:--');
}

/** Draw the identity half: artwork, title, category, and the wash. */
/** Show the "via API" label only while the archive is the source. */
function paintOrigin() {
  if (!ui.origin) return;
  ui.origin.hidden = state.source !== 'api';
}

function paintTrack() {
  const track = state.track;
  if (!track) return;

  ui.shot.textContent = '';
  ui.shot.appendChild(buildCover(track));

  ui.title.textContent = track.t;
  ui.title.title = track.t;

  const bits = [track.c];
  if (state.fromQueue) {
    bits.push('from the queue');
  } else if (state.context === 'playlist' && state.list.length) {
    bits.push(`${state.cursor + 1} of ${state.list.length}`);
  }
  if (state.queue.length) bits.push(`${state.queue.length} queued`);
  if (track.se) bits.push('session edit');
  ui.sub.textContent = bits.join('  ·  ');

  ui.bar.style.setProperty('--swatch', swatchFor(track.c));

  // The same per-title palette the artwork and the playlists hero use,
  // so the chrome and the cover can never disagree.
  const pal = coverSpec(track.t).pal;
  ui.bar.style.setProperty('--wash', pal[1]);
  ui.bar.style.setProperty('--wash-2', pal[2]);

  ui.status.textContent = state.source === 'api'
    ? `Playing ${track.t} from the archive, not from this machine`
    : `Playing ${track.t}`;
  setMediaSession(track);
  paintSide();
}

/* ---------- Add and save ---------- */

/** The record id of the save in flight, or null. */
let saving = null;
let noteTimer = null;

/** The feedback line under the title. Empty clears it at once;
    anything else clears itself after a few seconds. */
function note(text) {
  if (!ui.note) return;
  clearTimeout(noteTimer);
  ui.note.textContent = text || '';
  ui.note.hidden = !text;
  if (text) noteTimer = setTimeout(() => { ui.note.hidden = true; }, 5000);
}

/**
 * Which of the two side buttons apply to the loaded track. Add wants a
 * track; save wants a record id, a Rust side to save through, and no
 * file on disk yet. load() awaits loadIndex() before painting, so
 * byId is settled by the time this reads it.
 */
function paintSide() {
  if (!ui.add) return;
  const track = state.track;
  ui.add.hidden = !track;
  ui.screen.hidden = !track;
  const wanted = Boolean(track && track.rid && inTauri && !byId.has(track.rid));
  // Kept up while its own save is in flight, so the busy state is
  // visible even though the index may already know the file.
  const busy = Boolean(saving && track && saving === track.rid);
  ui.save.hidden = !wanted && !busy;
}

/**
 * Save the loaded track into the archive folder through Rust, then
 * teach the in-memory index about it so the next play is local and
 * hasAudio() answers true. The track keeps streaming if it was: a
 * switch mid-play would be a hiccup for nothing.
 */
async function saveTrack() {
  const track = state.track;
  if (!track || !track.rid || saving) return;

  saving = track.rid;
  ui.save.disabled = true;
  ui.save.classList.add('is-busy');
  ui.save.setAttribute('aria-label', 'Saving to this machine');
  note('Saving to this machine');

  try {
    const saved = await invoke('download_track', { rid: track.rid });
    byId.set(saved.rid, saved.file);
    const stem = saved.file.replace(/\s*\[[0-9a-f]{8}\]\.[^.]+$/i, '');
    const key = normalise(stem);
    if (key && !byTitle.has(key)) byTitle.set(key, saved.rid);
    // Rust's reply about the folder carried audio: false until now
    await refreshArchive();
    note(saved.already ? 'Already saved on this machine' : 'Saved to this machine');
    ui.status.textContent = `${track.t} saved to this machine`;
  } catch (err) {
    note((err && err.message) || String(err) || 'Could not save it');
  } finally {
    saving = null;
    ui.save.disabled = false;
    ui.save.classList.remove('is-busy');
    ui.save.setAttribute('aria-label', 'Save to this machine');
    paintSide();
  }
}

/** Pressing the artwork: hand the record to whoever is listening.
    Under the shell that is shell.js, which sends the frame to the
    Vault with the id; the Vault opens the panel. */
function openTrack() {
  const track = state.track;
  if (!track) return;
  document.dispatchEvent(new CustomEvent('nine:open-track', {
    detail: { rid: track.rid || null, title: track.t }
  }));
}

function paintContext() {
  // Shuffle is meaningless over a random pool, so it is withdrawn
  // there rather than offered and ignored.
  ui.shuffle.hidden = state.context !== 'playlist';
  ui.bar.dataset.context = state.context;
}

/* ---------- Media Session ----------
   Hardware keys and the OS media overlay, free and native. Guarded,
   because it is absent on some engines. */

function setMediaSession(track) {
  if (!('mediaSession' in navigator) || typeof window.MediaMetadata !== 'function') return;
  try {
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: track.t,
      artist: 'Juice WRLD',
      album: state.context === 'playlist' ? 'Playlist' : 'The Vault'
    });
  } catch {
    // Metadata is a nicety. The action handlers are the useful half.
  }
}

function wireMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, fn) => {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported action */ }
  };
  set('play', () => { audio.play().catch(() => {}); });
  set('pause', () => audio.pause());
  set('previoustrack', () => previous());
  set('nexttrack', () => next());
}

/* ---------- The recent queue ---------- */

/** Warm the in-memory mirror. Failure is survivable: an empty set
    just means nothing is excluded yet. */
function loadRecent() {
  return recentIds()
    .then((ids) => { recent = new Set(ids); })
    .catch(() => { recent = new Set(); });
}

/**
 * Record a play.
 *
 * On start rather than on end, because Next is a manual action: the
 * track has to be excluded before the pick that follows it, or the
 * button can hand back what is playing right now.
 */
function markPlayed(track) {
  const rid = ridFor(track);
  if (!rid) return;
  recent.add(rid);
  pushRecent(rid).catch(() => {
    // The database can be refused outright in a private window. The
    // in-memory set still covers this session.
  });
}

/* ---------- Choosing ---------- */

function shuffled(n) {
  const out = Array.from({ length: n }, (_, i) => i);
  // Fisher-Yates, in place. Dealt once and then stepped, so a track
  // cannot come round twice before the order is exhausted.
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function sequential(n) {
  return Array.from({ length: n }, (_, i) => i);
}

/** Rebuild the playlist order, keeping the playing track under the
    cursor so toggling shuffle does not jump the audio. */
function reorder() {
  const playing = state.order[state.cursor];
  state.order = state.shuffle ? shuffled(state.list.length) : sequential(state.list.length);

  if (playing === undefined) {
    state.cursor = state.list.length ? 0 : -1;
    return;
  }

  const at = state.order.indexOf(playing);
  if (state.shuffle && at > 0) {
    // Move it to the front of the shuffled order, so what follows is
    // the rest of the list rather than a jump back over it.
    state.order.splice(at, 1);
    state.order.unshift(playing);
    state.cursor = 0;
  } else {
    state.cursor = at;
  }
}

/**
 * A random Vault track, excluding the 200 most recent.
 *
 * The pool is whatever the grid is filtered to, not the whole
 * catalogue: filtering to instrumentals and pressing Next should stay
 * inside instrumentals. Tracks with no file on disk are dropped,
 * because a pick that cannot play is a dead button.
 */
function randomTrack() {
  // Under the shell the pool can belong to a Vault page that has since
  // navigated away. Its function still runs, over the list it had, so
  // Next carries on from that filter; if it cannot, the pool is empty.
  // Files on disk first. Only when the filtered set has none of those
  // (a fresh install with nothing pulled, or a filter on a category
  // that was never pulled) does the pick reach for tracks that can
  // stream, which load() does on its own when srcFor() finds nothing.
  let pool;
  try {
    const all = vaultPool();
    const streamable = all.filter((t) => t && t.rid);
    if (prefs.source === 'stream') {
      pool = streamable;
    } else {
      pool = all.filter(hasAudio);
      if (!pool.length) pool = streamable;
    }
  } catch { pool = []; }
  if (!pool.length) return null;

  const fresh = pool.filter((t) => !recent.has(ridFor(t)));

  // A narrow filter can leave the queue holding most of the pool.
  // Repeating sooner beats handing back nothing at all.
  let pick = fresh.length >= MIN_FRESH ? fresh : pool;

  // Never hand back what is already playing, unless that is all there is
  if (pick.length > 1 && state.track) {
    const rid = ridFor(state.track);
    const without = pick.filter((t) => ridFor(t) !== rid);
    if (without.length) pick = without;
  }

  return pick[Math.floor(Math.random() * pick.length)];
}

/* ---------- The sound lab ----------
   Speed and pitch are the element's own playbackRate and
   preservesPitch: always there, no CORS, nothing to build. Reverb, EQ
   and bass go through a Web Audio graph (fx.js), which is only built
   the first time a song needs it, and only after a one-byte probe
   shows the audio can be read. A media element routed through Web
   Audio plays silence for audio it may not read, and says nothing,
   so the probe is the guard against that. If it fails the lab keeps
   working for speed and says why the rest is off. */

const lab = {
  settings: neutralLab(),
  /** Where the settings in force came from: 'song', 'all' or 'none'.
      Edits are saved back to the same place. */
  scope: 'none',
  fx: createFx(),
  /** Both elements load in CORS mode and play through the graph. One
      way: an element cannot be taken back out of Web Audio. */
  engaged: false,
  /** Why reverb and EQ cannot run, for the panel, or ''. */
  blocked: '',
  pending: null
};

const labListeners = new Set();
/** origin -> whether a CORS read of it worked, so one probe each. */
const corsSeen = new Map();

function labKey(track) {
  if (!track) return null;
  return track.rid || (track.t ? `t:${normalise(track.t)}` : null);
}

/** Speed, and whether the pitch goes with it, on one element. The
    default rate is set too: loading a new file resets playbackRate to
    it. */
function applyRate(el, s) {
  if (!el) return;
  try {
    el.defaultPlaybackRate = s.rate;
    el.playbackRate = s.rate;
    const keep = !s.linked;
    el.preservesPitch = keep;
    el.mozPreservesPitch = keep;
    el.webkitPreservesPitch = keep;
  } catch { /* an engine without these: the song plays as recorded */ }
}

/** Whether a response can be read cross-origin: a one-byte ranged GET
    in CORS mode, which is exactly what the element will send. */
async function corsReadable(url) {
  if (!url || typeof fetch !== 'function') return false;
  let origin = '';
  try { origin = new URL(url, window.location.href).origin; } catch { return false; }
  if (corsSeen.has(origin)) return corsSeen.get(origin);

  let ok = false;
  try {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const res = await fetch(url, {
      mode: 'cors',
      headers: { Range: 'bytes=0-0' },
      signal: ctl ? ctl.signal : undefined
    });
    ok = Boolean(res && res.ok);
    if (ctl) ctl.abort();
  } catch {
    ok = false;
  }
  // Only a yes is remembered. A no may be a dropped connection, and
  // a session should not lose the effects for good because of one.
  if (ok) corsSeen.set(origin, true);
  return ok;
}

/** Build the graph and put both elements in CORS mode. False, with a
    reason in lab.blocked, when it cannot be done. */
async function engageFx(url) {
  if (lab.engaged) return true;
  if (!lab.fx.supported) {
    lab.blocked = 'This build of the app has no Web Audio, so reverb and the equalizer are off. Speed and pitch still work.';
    return false;
  }
  if (!(await corsReadable(url))) {
    lab.blocked = 'The app is not allowed to process this audio, so reverb and the equalizer are off. Speed and pitch still work.';
    return false;
  }
  if (!lab.fx.ensure()) {
    lab.blocked = 'Web Audio would not start, so reverb and the equalizer are off. Speed and pitch still work.';
    return false;
  }
  audio.crossOrigin = 'anonymous';
  if (spare) spare.crossOrigin = 'anonymous';
  lab.engaged = true;
  lab.blocked = '';
  return true;
}

/** Engage while a song is already playing: reload the same file in
    CORS mode at the same place, and route it. */
async function engageNow() {
  const el = audio;
  const url = el.currentSrc || el.getAttribute('src');
  if (!url) return false;
  if (!(await engageFx(url))) return false;
  if (el !== audio) return true; // a crossfade swapped it meanwhile; the next load routes it

  const at = el.currentTime || 0;
  const was = !el.paused;
  el.src = url;
  el.addEventListener('loadedmetadata', () => {
    try { el.currentTime = at; } catch { /* not seekable yet */ }
  }, { once: true });
  lab.fx.attach(el);
  applyRate(el, lab.settings);
  if (was) el.play().catch(() => paintPlaying(false));
  return true;
}

function labSnapshot() {
  return {
    settings: cleanLab(lab.settings),
    scope: lab.scope,
    engaged: lab.engaged,
    supported: lab.fx.supported,
    blocked: lab.blocked,
    track: state.track
  };
}

function labChanged() {
  paintLabButton();
  const snap = labSnapshot();
  labListeners.forEach((fn) => {
    try { fn(snap); } catch { /* a panel must not take the player down */ }
  });
}

function paintLabButton() {
  if (!ui.lab) return;
  const on = !isNeutral(lab.settings);
  ui.lab.classList.toggle('is-on', on);
  ui.lab.setAttribute('aria-label', on ? 'Sound lab, effects on' : 'Sound lab');
}

/** The lab as it stands, a copy. */
export function labState() {
  if (HOST) return HOST.labState();
  return labSnapshot();
}

export function onLab(fn) {
  if (HOST) {
    const off = HOST.onLab(fn);
    window.addEventListener('pagehide', off, { once: true });
    return off;
  }
  labListeners.add(fn);
  fn(labSnapshot());
  return () => labListeners.delete(fn);
}

/** Save the settings where they came from: this song's own entry, or
    the one for every song. */
function persistLab() {
  if (lab.scope === 'all') {
    remember(null, 'all', lab.settings);
  } else {
    remember(labKey(state.track), 'song', lab.settings);
    lab.scope = isNeutral(lab.settings) ? 'none' : 'song';
  }
}

/**
 * Change some of the settings, apply them now and keep them. Speed and
 * pitch land at once; the first reverb, EQ or bass reloads the song in
 * place, once, to route it through Web Audio.
 */
export async function setLab(patch = {}) {
  if (HOST) return HOST.setLab(patch);
  lab.settings = cleanLab({ ...lab.settings, ...patch });
  applyRate(audio, lab.settings);
  applyRate(spare, lab.settings);
  persistLab();

  if (needsGraph(lab.settings) && !lab.engaged && state.track) {
    if (!lab.pending) {
      lab.pending = engageNow().finally(() => { lab.pending = null; });
    }
    await lab.pending;
  }
  if (lab.engaged) {
    lab.fx.apply(lab.settings);
    lab.fx.resume();
  }
  presenceSync();
  labChanged();
  return labSnapshot();
}

/** Back to the recording, for this song (or for every song, when
    that is where the settings live). */
export function resetLab() {
  if (HOST) return HOST.resetLab();
  return setLab(neutralLab());
}

/** Make the current settings the ones for every song ('all'), or this
    song's alone ('song'). */
export function setLabScope(scope) {
  if (HOST) return HOST.setLabScope(scope);
  const key = labKey(state.track);
  if (scope === 'all') {
    remember(null, 'all', lab.settings);
    forget(key);
    lab.scope = 'all';
  } else {
    remember(null, 'all', neutralLab());
    remember(key, 'song', lab.settings);
    lab.scope = isNeutral(lab.settings) ? 'none' : 'song';
  }
  labChanged();
  return labSnapshot();
}

/** A song is about to load: what does the lab say for it? Applied to
    the element by load() itself. */
function labFor(track) {
  const r = recall(labKey(track));
  lab.settings = r.settings;
  lab.scope = r.scope;
}

/* ---------- Crossfade ----------
   The next song starts on the idle element while the old one fades
   out under it, then the two simply trade jobs. The fade runs on the
   elements' own volume, so it needs no Web Audio and works through the
   graph or without it. It is started from the end of a song by a
   timeupdate, and only when the song ending would have carried on to
   another one: a lone Vault track, the end of a playlist, repeat-one
   and the sleep timer's "end of this song" all end the way they
   always did. A press of Next is not a crossfade. */

/** Set by startCrossfade() and read, synchronously, by the load() that
    next() calls. */
let wantFade = false;
/** { out, started, t0, len, timer } while a fade is under way. */
let fade = null;

function ensureSpare() {
  if (!spare) {
    spare = new Audio();
    spare.preload = 'metadata';
    if (lab.engaged) spare.crossOrigin = 'anonymous';
    bindElement(spare);
  }
  spare.muted = audio.muted;
  spare.volume = level;
  applyRate(spare, lab.settings);
  return spare;
}

/** The idle element becomes the live one, silent, and the old one is
    left playing in the background until the fade ends. */
function swapForFade() {
  const out = audio;
  const incoming = ensureSpare();
  audio = incoming;
  spare = out;
  audio.volume = 0;
  fade = { out, started: false, t0: 0, len: 0, timer: null };
}

/** Called when the incoming song is actually making sound, so the
    overlap is measured from there and not from the request. */
function rampStart() {
  const f = fade;
  if (!f || f.started) return;
  f.started = true;

  const left = Number.isFinite(f.out.duration) ? f.out.duration - f.out.currentTime : 0;
  const wanted = Math.max(1, prefs.crossfade);
  f.len = Math.max(0.4, left > 0 ? Math.min(wanted, left) : wanted) * 1000;
  f.t0 = Date.now();
  f.timer = setInterval(() => {
    const p = Math.min(1, (Date.now() - f.t0) / f.len);
    // Equal power: the sum of the two stays level through the middle
    audio.volume = level * Math.sin(p * Math.PI / 2);
    f.out.volume = level * Math.cos(p * Math.PI / 2);
    if (p >= 1) finishFade();
  }, 50);
}

/** Cut the outgoing element and put the volumes back. Safe to call
    with no fade, and from anywhere the old song must stop at once. */
function finishFade() {
  if (!fade) return;
  const f = fade;
  fade = null;
  clearInterval(f.timer);
  try {
    f.out.pause();
    f.out.removeAttribute('src');
    f.out.load();
  } catch { /* already gone */ }
  f.out.volume = level;
  audio.volume = level;
}

/** Whether the song now ending should hand over by fading. */
function crossfadeWanted() {
  if (!prefs.crossfade || fade || !state.track || audio.paused) return false;
  if (sleep.mode === 'song' || state.repeat === 'one') return false;

  const dur = audio.duration;
  if (!Number.isFinite(dur) || dur <= 0) return false;
  // Not for a song shorter than two overlaps: there is nothing to fade
  if (dur < prefs.crossfade * 2) return false;
  const left = dur - audio.currentTime;
  if (left > prefs.crossfade + 0.4 || left <= 0.15) return false;

  // Would the song ending have gone on to another one?
  if (state.queue.length) return true;
  if (state.context === 'playlist') {
    if (!state.list.length) return false;
    return state.cursor + 1 < state.order.length || state.repeat === 'all';
  }
  return state.repeat === 'all';
}

function maybeCrossfade() {
  if (!crossfadeWanted()) return;
  wantFade = true;
  try {
    next({ auto: true });
  } finally {
    wantFade = false;
  }
}

/* ---------- The sleep timer ----------
   Pauses the music after a set time, or at the end of the song that
   is playing. Off until one is chosen, and gone when the app closes. */

const sleep = { mode: null, until: 0, timer: null, tick: null };
const sleepListeners = new Set();

function sleepSnapshot() {
  const left = sleep.mode === 'timer' ? Math.max(0, Math.round((sleep.until - Date.now()) / 1000)) : 0;
  return { mode: sleep.mode, until: sleep.until, left };
}

function clearSleepTimers() {
  clearTimeout(sleep.timer);
  clearInterval(sleep.tick);
  sleep.timer = null;
  sleep.tick = null;
}

function sleepChanged() {
  if (ui.sleep) {
    const snap = sleepSnapshot();
    ui.sleep.classList.toggle('is-on', Boolean(snap.mode));
    ui.sleepN.hidden = !snap.mode;
    ui.sleepN.textContent = snap.mode === 'song' ? 'end' : `${Math.max(1, Math.ceil(snap.left / 60))}m`;
    ui.sleep.setAttribute('aria-label', snap.mode ? 'Sleep timer is set' : 'Sleep timer');
  }
  const snap = sleepSnapshot();
  sleepListeners.forEach((fn) => {
    try { fn(snap); } catch { /* as above */ }
  });
}

function sleepFire() {
  clearSleepTimers();
  sleep.mode = null;
  sleep.until = 0;
  finishFade();
  if (state.track && !audio.paused) audio.pause();
  note('Sleep timer: paused');
  sleepChanged();
}

/** Start the timer: a number of minutes, or 'song' for the end of the
    one that is playing. Replaces any timer already set. */
export function startSleep(how) {
  if (HOST) { HOST.startSleep(how); return; }
  clearSleepTimers();
  sleep.mode = null;
  sleep.until = 0;

  if (how === 'song') {
    sleep.mode = 'song';
  } else {
    const minutes = Number(how);
    if (Number.isFinite(minutes) && minutes > 0) {
      sleep.mode = 'timer';
      sleep.until = Date.now() + minutes * 60000;
      sleep.timer = setTimeout(sleepFire, minutes * 60000);
      // A laptop that slept holds a setTimeout back; the clock does not
      sleep.tick = setInterval(() => {
        if (Date.now() >= sleep.until) sleepFire();
        else sleepChanged();
      }, 1000);
    }
  }
  sleepChanged();
}

export function cancelSleep() {
  if (HOST) { HOST.cancelSleep(); return; }
  clearSleepTimers();
  sleep.mode = null;
  sleep.until = 0;
  sleepChanged();
}

export function sleepState() {
  if (HOST) return HOST.sleepState();
  return sleepSnapshot();
}

export function onSleep(fn) {
  if (HOST) {
    const off = HOST.onSleep(fn);
    window.addEventListener('pagehide', off, { once: true });
    return off;
  }
  sleepListeners.add(fn);
  fn(sleepSnapshot());
  return () => sleepListeners.delete(fn);
}

/* ---------- Loading ---------- */

/** Which load() is the newest. A load that finds it has been
    overtaken after an await lets go instead of overwriting it. */
let loadSeq = 0;

/**
 * Point the element at a track and, unless told otherwise, play it.
 *
 * Returns false when the track has no file: the bar says so and stays
 * on screen rather than throwing inside a click handler.
 */
async function load(track, { autoplay = true, at = 0, resumeId = null } = {}) {
  // Read before the first await: startCrossfade() raises it and next()
  // calls straight in here, so this is the one place it can be seen.
  const fadeIn = wantFade;
  wantFade = false;
  const mine = ++loadSeq;

  await loadIndex();
  if (mine !== loadSeq) return false;
  clearApiTimer();

  // Close the book on whatever was playing before the switch. A track
  // resumed from the previous page keeps the row it already had, so a
  // navigation mid-track is one play, not two.
  tick();
  flushListened();

  // A crossfade moves the song that is ending to the other element and
  // lets it run out under this one. Any other load cuts a fade short:
  // a person who picked something else wants that, now.
  if (fadeIn && audio.getAttribute('src') && !audio.paused) {
    swapForFade();
  } else {
    finishFade();
    audio.volume = level;
  }
  playId = resumeId || null;
  logging = false;
  lastPos = at > 0 ? at : 0;
  unflushed = 0;

  // Which of the two comes first is the `source` setting. Local first
  // is the default: the file if there is one, the stream only for a
  // track that was never pulled. Stream first is the opposite, and the
  // file is then what apiFailed() falls back to.
  const local = srcFor(track);
  const stream = apiSrcFor(track);
  const src = prefs.source === 'stream' ? (stream || local) : (local || stream);
  state.source = src ? (src === stream ? 'api' : 'local') : null;
  state.track = track;
  wantPlay = autoplay;

  // What the lab remembers for this song, or for every song
  labFor(track);

  // A song picked ahead for Next that is now the one playing is spent
  if (state.peek && sameTrack(state.peek, track)) state.peek = null;

  mount();
  ui.bar.hidden = false;
  document.body.classList.add('has-player');
  paintTrack();
  paintContext();
  paintOrigin();
  // The track has changed even though nothing is playing yet: the
  // pages move their mark now and the play event lights it up.
  notify();
  labChanged();
  // The running order or the song moved, so what is coming up did too
  notifyUpNext();

  if (!src) {
    // Nothing to hand over to: the song that was fading out stops here
    finishFade();
    audio.pause();
    audio.removeAttribute('src');
    ui.bar.classList.add('is-missing');
    ui.range.disabled = true;
    ui.sub.textContent = 'Not saved to this machine';
    ui.status.textContent = `${track.t} has no audio file saved`;
    paintPlaying(false);
    return false;
  }

  ui.bar.classList.remove('is-missing');
  ui.range.disabled = false;
  ui.range.value = '0';
  fill(ui.range);

  // Reverb, EQ or bass remembered for this song: build the graph
  // before the file is requested, so the request is made in CORS mode
  // and the song does not have to be loaded twice.
  if (needsGraph(lab.settings) && !lab.engaged) {
    await engageFx(src);
    if (mine !== loadSeq) return false;
  }

  audio.src = src;
  applyRate(audio, lab.settings);
  if (lab.engaged) {
    lab.fx.attach(audio);
    lab.fx.apply(lab.settings);
    lab.fx.resume();
  }

  if (state.source === 'api') {
    // A 404 or a dead network fires `error` and is handled there. This
    // is for the connection that neither answers nor fails.
    apiTimer = setTimeout(() => {
      if (state.source === 'api' && audio.readyState < 1) {
        apiFailed('The archive did not answer');
      }
    }, API_TIMEOUT);
  }

  if (at > 0) {
    // currentTime set before metadata is discarded, so wait until the
    // seek is legal rather than setting it and hoping.
    audio.addEventListener('loadedmetadata', () => { audio.currentTime = at; }, { once: true });
  }

  markPlayed(track);

  if (!autoplay) {
    paintPlaying(false);
    return true;
  }

  try {
    await audio.play();
  } catch {
    // Autoplay policy, or the file moved. Either way the bar is up and
    // the play button works, so this is not worth an alarm.
    paintPlaying(false);
  }
  return true;
}

/* ---------- Public API ---------- */

/**
 * Play one track from the Vault grid.
 *
 * The history stack is this context's Previous, so the track being
 * left behind goes on it.
 */
export function playTrack(track) {
  if (HOST) return HOST.playTrack(track);
  if (state.track && state.context === 'vault' && state.track !== track) {
    state.history.push(state.track);
  }
  state.context = 'vault';
  state.playlistId = null;
  state.list = [];
  state.order = [];
  state.cursor = -1;
  state.fromQueue = false;
  return load(track);
}

/* ---------- The queue ---------- */

/**
 * Put a track next in line. With nothing loaded it simply plays.
 *
 * Returns how many are waiting, so the page can say so. The queue
 * survives a change of context: a track queued from a playlist still
 * comes up after a Vault pick, because that is what asking for it
 * meant.
 */
export function enqueue(track) {
  if (HOST) return HOST.enqueue(track);
  return enqueueMany(track ? [track] : []);
}

/**
 * Put several tracks in line at once, in the order given, after
 * whatever is already waiting. The same song can be in the queue more
 * than once, and can be asked for again while it is the one playing:
 * a queue is a list of requests, not a set of songs.
 *
 * With nothing loaded the first one plays and the rest wait behind it.
 * Returns how many are waiting afterwards.
 */
export function enqueueMany(tracks) {
  if (HOST) return HOST.enqueueMany(tracks);
  const wanted = (Array.isArray(tracks) ? tracks : []).filter(Boolean);
  if (!wanted.length) return state.queue.length;

  let rest = wanted;
  if (!state.track) {
    playTrack(wanted[0]);
    rest = wanted.slice(1);
  }
  rest.forEach((track) => { state.queue.push({ qid: ++queueSeq, track }); });

  if (rest.length) {
    note(rest.length === 1
      ? `Next: ${rest[0].t}`
      : `${rest.length} songs added to the queue`);
  }
  queueChanged();
  return state.queue.length;
}

/** What is waiting, first to play first. The tracks only, a copy. */
export function queued() {
  if (HOST) return HOST.queued();
  return state.queue.map((entry) => entry.track);
}

/** What is waiting, as { qid, track }, for a panel that has to point
    at one entry. Two entries for the same song have different ids. */
export function queueEntries() {
  if (HOST) return HOST.queueEntries();
  return state.queue.map((entry) => ({ qid: entry.qid, track: entry.track }));
}

/** Take one entry out by its id. False if it has already gone (it
    started playing, or was removed from somewhere else). */
export function removeFromQueue(qid) {
  if (HOST) return HOST.removeFromQueue(qid);
  const at = state.queue.findIndex((entry) => entry.qid === qid);
  if (at < 0) return false;
  state.queue.splice(at, 1);
  queueChanged();
  return true;
}

/**
 * Play a queued song now, from the Up next panel. The songs queued
 * before it are skipped (they would have played first, and the person
 * has chosen to go past them); the ones after it stay queued and follow.
 * False if the entry has already gone.
 */
export function playQueued(qid) {
  if (HOST) return HOST.playQueued(qid);
  const at = state.queue.findIndex((entry) => entry.qid === qid);
  if (at < 0) return false;
  // Everything up to and including the pressed one leaves the queue;
  // the pressed one is the last of those, and it is what plays
  const gone = state.queue.splice(0, at + 1);
  const entry = gone[gone.length - 1];
  if (state.context === 'vault' && state.track) state.history.push(state.track);
  state.fromQueue = true;
  load(entry.track);
  queueChanged();
  return true;
}

/**
 * Play one of the songs that follow on their own, from the Up next
 * panel: `index` is its place in upNext().then.tracks. In a playlist the
 * running order moves to that song, so the ones after it follow, and
 * whatever is queued still plays after it. In the Vault it is the song
 * that was named. With repeat one it starts this song again.
 */
export function playUpcoming(index) {
  if (HOST) return HOST.playUpcoming(index);
  if (!state.track || !Number.isInteger(index) || index < 0) return false;

  if (state.repeat === 'one') {
    audio.currentTime = 0;
    audio.play().catch(() => paintPlaying(false));
    return true;
  }

  if (state.context === 'playlist' && state.list.length && state.order.length) {
    const n = state.order.length;
    let at = state.cursor + index + 1;
    if (at >= n) {
      if (state.repeat !== 'all') return false;
      at -= n;
    }
    if (at === state.cursor || at < 0 || at >= n) return false;
    const track = state.list[state.order[at]];
    if (!track) return false;
    state.cursor = at;
    state.fromQueue = false;
    load(track);
    return true;
  }

  if (state.context === 'vault' && index === 0 && state.peek) {
    const pick = state.peek;
    state.peek = null;
    if (state.track) state.history.push(state.track);
    state.fromQueue = false;
    load(pick);
    return true;
  }
  return false;
}

export function clearQueue() {
  if (HOST) { HOST.clearQueue(); return; }
  if (!state.queue.length) return;
  state.queue = [];
  queueChanged();
}

/** The next id. Never reused, so a stale click cannot hit a newer
    entry that happens to hold the same song. */
let queueSeq = 0;

const queueListeners = new Set();

/** Tell the bar and every panel that the queue is not what it was. */
function queueChanged() {
  if (state.track) paintTrack();
  paintQueueButton();
  const entries = state.queue.map((entry) => ({ qid: entry.qid, track: entry.track }));
  queueListeners.forEach((fn) => {
    try { fn(entries); } catch { /* a panel must not take the player down */ }
  });
  notifyUpNext();
}

/** Be told whenever the queue changes, and once straight away.
    Returns the unsubscribe. */
export function onQueue(fn) {
  if (HOST) {
    const off = HOST.onQueue(fn);
    window.addEventListener('pagehide', off, { once: true });
    return off;
  }
  queueListeners.add(fn);
  fn(queueEntries());
  return () => queueListeners.delete(fn);
}

/**
 * What will play after this, in the order it will play.
 *
 *   queue   what was asked for, as { qid, track }. Plays first.
 *   then    what carries on after the queue:
 *             kind 'playlist'    the rest of the running order, in the
 *                                shuffled order when shuffle is on, and
 *                                round to the start when repeat is all
 *             kind 'vault'       the one random song Next will pick,
 *                                chosen now so it can be named
 *             kind 'repeat-one'  this song again
 *             kind 'none'        nothing: the end of the list, or
 *                                nothing is loaded
 *           with `tracks` (at most `limit`) and `more`, how many more
 *           follow past those.
 */
export function upNext(limit = 50) {
  if (HOST) return HOST.upNext(limit);

  const queue = state.queue.map((entry) => ({ qid: entry.qid, track: entry.track }));
  const none = { kind: 'none', tracks: [], more: 0 };
  if (!state.track) return { queue, then: none };

  if (state.repeat === 'one') {
    return { queue, then: { kind: 'repeat-one', tracks: [state.track], more: 0 } };
  }

  if (state.context === 'playlist' && state.list.length && state.order.length) {
    const n = state.order.length;
    const tracks = [];
    // The current song is order[cursor]; what follows is the cursor
    // moving on, and with repeat all it goes round to the start. Stops
    // before it would reach the current song again.
    for (let k = 1; k < n && tracks.length < limit; k++) {
      let at = state.cursor + k;
      if (at >= n) {
        if (state.repeat !== 'all') break;
        at -= n;
      }
      const track = state.list[state.order[at]];
      if (track) tracks.push(track);
    }
    const reachable = state.repeat === 'all' ? n - 1 : Math.max(0, n - 1 - state.cursor);
    return {
      queue,
      then: { kind: tracks.length ? 'playlist' : 'none', tracks, more: Math.max(0, reachable - tracks.length) }
    };
  }

  if (state.context === 'vault') {
    // Only when the queue is empty is this the next song, but naming it
    // early costs nothing and next() uses the same pick.
    if (!state.peek) {
      try { state.peek = randomTrack(); } catch { state.peek = null; }
    }
    if (state.peek) return { queue, then: { kind: 'vault', tracks: [state.peek], more: 0 } };
  }
  return { queue, then: none };
}

const upNextListeners = new Set();

function notifyUpNext() {
  if (!upNextListeners.size) return;
  let snap;
  try { snap = upNext(); } catch { return; }
  upNextListeners.forEach((fn) => {
    try { fn(snap); } catch { /* a panel must not take the player down */ }
  });
}

/** Be told whenever what is coming up changes (the queue, the running
    order, shuffle, repeat, the song), and once straight away. Returns
    the unsubscribe. */
export function onUpNext(fn) {
  if (HOST) {
    const off = HOST.onUpNext(fn);
    window.addEventListener('pagehide', off, { once: true });
    return off;
  }
  upNextListeners.add(fn);
  try { fn(upNext()); } catch { /* as above */ }
  return () => upNextListeners.delete(fn);
}

/** The count on the bar's queue button. */
function paintQueueButton() {
  if (!ui.queueN) return;
  const n = state.queue.length;
  ui.queueN.hidden = n === 0;
  ui.queueN.textContent = n > 99 ? '99+' : String(n);
  ui.queueBtn.setAttribute('aria-label', n ? `Up next, ${n} waiting` : 'Up next');
}

/** Take the next queued track. The context's own cursor is untouched,
    so when this one ends the running order resumes where it was. */
function serveQueue() {
  const entry = state.queue.shift();
  if (state.context === 'vault' && state.track) state.history.push(state.track);
  state.fromQueue = true;
  const started = load(entry.track);
  queueChanged();
  return started;
}

/**
 * Play from inside a playlist.
 *
 * `items` is the whole list in playlist order, so Next has somewhere
 * to go without reading the database again.
 */
export function playFromPlaylist(playlistId, items, index) {
  if (HOST) return HOST.playFromPlaylist(playlistId, items, index);
  state.context = 'playlist';
  state.playlistId = playlistId;
  state.list = items.slice();
  state.history = [];
  state.fromQueue = false;
  state.order = state.shuffle ? shuffled(state.list.length) : sequential(state.list.length);

  if (state.shuffle) {
    // Start on the row that was clicked, not on wherever the shuffle
    // happened to put it.
    const at = state.order.indexOf(index);
    if (at > 0) {
      state.order.splice(at, 1);
      state.order.unshift(index);
    }
    state.cursor = 0;
  } else {
    state.cursor = index;
  }

  return load(state.list[state.order[state.cursor]]);
}

/**
 * Where the element is: seconds in, and the length (0 until metadata
 * lands). For the idle screen's progress line, which polls it while up
 * rather than listening to timeupdate on an element it cannot see.
 */
export function timing() {
  if (HOST) return HOST.timing();
  return {
    at: audio.currentTime || 0,
    total: Number.isFinite(audio.duration) ? audio.duration : 0
  };
}

/**
 * Jump to a position, in seconds. Clamped to the song, so a click on a
 * lyric stamped past the end of a short file lands at the end rather
 * than throwing. Nothing loaded, or no length known yet: nothing
 * happens. Returns where it went, or null.
 */
export function seekTo(sec) {
  if (HOST) return HOST.seekTo(sec);
  const want = Number(sec);
  if (!state.track || !Number.isFinite(want)) return null;
  const total = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null;
  if (total === null) return null;
  const to = Math.min(Math.max(0, want), Math.max(0, total - 0.05));
  try { audio.currentTime = to; } catch { return null; }
  return to;
}

/**
 * Move the volume by `delta` (0.05 is five points), clamped to 0..1, and
 * keep the bar's slider, the mute icon and the saved level in step with
 * it, exactly as dragging the slider does. Returns the new level. A
 * nudge up from muted unmutes, because the slider does the same.
 */
export function nudgeVolume(delta) {
  if (HOST) return HOST.nudgeVolume(delta);
  level = Math.min(1, Math.max(0, Math.round((level + delta) * 100) / 100));
  audio.volume = level;
  setMuted(level === 0);
  if (mounted) {
    ui.volume.value = String(Math.round(level * 100));
    paintVolume();
  }
  try { localStorage.setItem(VOL_KEY, String(level)); } catch { /* refused */ }
  return level;
}

/** Mute both elements, so a crossfade does not un-mute the other. */
function setMuted(on) {
  audio.muted = on;
  if (spare) spare.muted = on;
}

/** Play, or pause. */
export function toggle() {
  if (HOST) { HOST.toggle(); return; }
  if (!state.track) return;
  if (audio.paused) audio.play().catch(() => paintPlaying(false));
  else audio.pause();
}

/**
 * Next. Random in the Vault, the next index in a playlist.
 *
 * `auto` marks the call as coming from the end of a track rather than
 * from the button, which is what decides whether the end of a
 * playlist wraps or stops.
 */
export function next({ auto = false } = {}) {
  if (HOST) { HOST.next({ auto }); return; }

  // Whatever was asked for comes first, in either context
  if (state.queue.length) {
    serveQueue();
    return;
  }
  state.fromQueue = false;

  if (state.context === 'playlist') {
    if (!state.list.length) return;

    if (state.cursor + 1 < state.order.length) {
      state.cursor++;
    } else if (state.repeat === 'all' || !auto) {
      state.cursor = 0;
    } else {
      audio.pause();
      return;
    }

    load(state.list[state.order[state.cursor]]);
    return;
  }

  // The song the Up next panel already named, if there is one
  const pick = state.peek || randomTrack();
  state.peek = null;
  if (!pick) {
    ui.status.textContent = 'Nothing left to play in this filter';
    return;
  }
  if (state.track) state.history.push(state.track);
  load(pick);
}

/** Previous. The history stack in the Vault, one index back in a playlist. */
export function previous() {
  if (HOST) { HOST.previous(); return; }
  // The convention everywhere else: a few seconds in, Previous
  // restarts the track rather than leaving it.
  if (audio.currentTime > 3 && !audio.paused) {
    audio.currentTime = 0;
    return;
  }

  if (state.context === 'playlist') {
    if (!state.list.length) return;
    // Back from a queued track is the row the order was on, whose
    // cursor never moved; only from there does it step back.
    if (!state.fromQueue) {
      state.cursor = state.cursor > 0 ? state.cursor - 1 : state.order.length - 1;
    }
    state.fromQueue = false;
    load(state.list[state.order[state.cursor]]);
    return;
  }

  state.fromQueue = false;
  const back = state.history.pop();
  if (!back) {
    audio.currentTime = 0;
    return;
  }
  load(back);
}

/**
 * Shuffle. Off re-deals the sequential order.
 *
 * The flag can be set with nothing playing, so the playlists page can
 * arm it and have the next Play start shuffled. Only a playlist has
 * an order to re-deal, so that half is skipped in the Vault, where
 * the control is not offered at all.
 */
export function toggleShuffle() {
  if (HOST) return HOST.toggleShuffle();
  state.shuffle = !state.shuffle;
  if (state.context === 'playlist' && state.list.length) reorder();

  mount();
  ui.shuffle.setAttribute('aria-pressed', String(state.shuffle));
  ui.shuffle.classList.toggle('is-on', state.shuffle);
  ui.status.textContent = state.shuffle ? 'Shuffle on' : 'Shuffle off';
  if (state.track) paintTrack();
  // Shuffling re-deals the running order, so what is next changed
  notifyUpNext();
  return state.shuffle;
}

/** Whether shuffle is armed, so a page can draw its own control to match. */
export function isShuffled() {
  if (HOST) return HOST.isShuffled();
  return state.shuffle;
}

/** off -> all -> one -> off. */
export function cycleRepeat() {
  if (HOST) { HOST.cycleRepeat(); return; }
  const order = ['off', 'all', 'one'];
  state.repeat = order[(order.indexOf(state.repeat) + 1) % order.length];

  // Handled in the ended handler, which has to tell the two contexts
  // apart. The element's own loop flag cannot.
  audio.loop = false;

  ui.repeat.dataset.mode = state.repeat;
  ui.repeat.setAttribute('aria-pressed', String(state.repeat !== 'off'));
  ui.repeat.setAttribute('aria-label', `Repeat: ${state.repeat}`);
  ui.repeat.classList.toggle('is-on', state.repeat !== 'off');
  ui.status.textContent = `Repeat ${state.repeat}`;
  // Discord's line says "On repeat" for repeat-one, so it changes here.
  presenceSync();
  // Repeat all wraps the running order, repeat one is this song again
  notifyUpNext();
}

/** Stop and put the bar away. The audio is released, not just paused. */
export function stop() {
  if (HOST) { HOST.stop(); return; }
  tick();
  flushListened();
  playId = null;
  finishFade();
  audio.pause();
  audio.removeAttribute('src');
  // Releases the buffered file rather than leaving the element holding
  // it. It fires an error event with no source, which the handler
  // below already stands aside for.
  audio.load();
  clearApiTimer();
  // Nothing left to count down to, and nothing left to be queued
  clearSleepTimers();
  sleep.mode = null;
  sleep.until = 0;
  state.track = null;
  state.source = null;
  state.history = [];
  state.queue = [];
  state.fromQueue = false;
  sleepChanged();
  queueChanged();
  labChanged();
  if (mounted) {
    ui.bar.hidden = true;
    paintOrigin();
    paintPlaying(false);
    paintSide();
    note('');
  }
  document.body.classList.remove('has-player');
  clearResume();
  presenceSync();
}

/** Whether the bar currently owns the keyboard, so a page's global
    handler can stand aside the way app.js does for the picker. */
export function isPlayerFocused() {
  // Focus inside the shell's bar is never inside this page's document,
  // so a framed page can answer for itself
  if (HOST) return false;
  return mounted && ui.bar.contains(document.activeElement);
}

/* ---------- Resume across pages ----------
   These are four separate pages, not routes: a navigation tears the
   <audio> element down whatever we do. So the state is written out
   and rebuilt on the other side, which is the resumable half of the
   requirement rather than the impossible half. */

let lastWrite = 0;

function saveResume() {
  if (!state.track) return;
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify({
      // The snapshot travels with it, so the next page can draw the
      // bar without the catalogue. playlists.html never reads it.
      track: state.track,
      context: state.context,
      playlistId: state.playlistId,
      at: audio.currentTime || 0,
      paused: audio.paused,
      shuffle: state.shuffle,
      repeat: state.repeat,
      // So the next page carries on the same play rather than logging
      // a second one for the same listen
      playId
    }));
  } catch {
    // Storage refused. The player still works, it just will not
    // survive the next launch.
  }
}

function clearResume() {
  try { localStorage.removeItem(RESUME_KEY); } catch { /* refused */ }
}

/**
 * Pick up where the last launch, or the last reload, left off.
 *
 * On a reload of the shell, autoplay is attempted if it was playing,
 * and a refusal is expected: the click that started it belonged to
 * the document before this one, so the gesture does not carry over.
 * Failing lands on a loaded, seeked, paused track, one keypress from
 * right. On a cold start of the app it is not attempted at all: the
 * bar comes up with the last track at the position it was closed on,
 * paused, and the play button carries on from there. An app that
 * starts making sound on its own is not what was asked for.
 */
async function restore() {
  let saved = null;
  let warm = false;
  try {
    saved = JSON.parse(localStorage.getItem(RESUME_KEY) || 'null');
    warm = sessionStorage.getItem(WARM_KEY) === '1';
    sessionStorage.setItem(WARM_KEY, '1');
  } catch {
    saved = null;
  }
  if (!saved || !saved.track) return;

  state.context = saved.context === 'playlist' ? 'playlist' : 'vault';
  state.playlistId = saved.playlistId || null;
  state.shuffle = Boolean(saved.shuffle);
  state.repeat = saved.repeat || 'off';

  // Rebuild the queue, so Next works straight away rather than after
  // the reader clicks something.
  if (state.context === 'playlist' && state.playlistId) {
    try {
      state.list = await itemsIn(state.playlistId);
      const at = state.list.findIndex((row) => row.t === saved.track.t);
      state.order = state.shuffle ? shuffled(state.list.length) : sequential(state.list.length);
      state.cursor = Math.max(0, state.order.indexOf(at < 0 ? 0 : at));
    } catch {
      state.list = [];
      state.order = [];
      state.cursor = -1;
    }
  }

  mount();
  ui.shuffle.setAttribute('aria-pressed', String(state.shuffle));
  ui.shuffle.classList.toggle('is-on', state.shuffle);
  ui.repeat.dataset.mode = state.repeat;
  ui.repeat.classList.toggle('is-on', state.repeat !== 'off');
  ui.repeat.setAttribute('aria-label', `Repeat: ${state.repeat}`);

  await load(saved.track, {
    autoplay: warm && !saved.paused,
    at: Number(saved.at) || 0,
    resumeId: saved.playId || null
  });
}

/* ---------- Events ---------- */

let seeking = false;

function wire() {
  ui.play.addEventListener('click', toggle);
  ui.next.addEventListener('click', () => next());
  ui.prev.addEventListener('click', previous);
  ui.shuffle.addEventListener('click', toggleShuffle);
  ui.repeat.addEventListener('click', cycleRepeat);
  ui.close.addEventListener('click', stop);
  ui.save.addEventListener('click', saveTrack);
  ui.screen.addEventListener('click', () => {
    if (state.track) document.dispatchEvent(new CustomEvent('nine:open-screen'));
  });
  ui.add.addEventListener('click', () => {
    if (state.track) openPicker(state.track, ui.add);
  });
  ui.shot.addEventListener('click', openTrack);

  // The three panels belong to the shell; each press says which button
  // so the panel can sit above it.
  [['queueBtn', 'nine:open-queue'], ['lab', 'nine:open-lab'], ['sleep', 'nine:open-sleep']]
    .forEach(([name, type]) => {
      ui[name].addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent(type, { detail: { anchor: ui[name] } }));
      });
    });

  /* ---- Seeking ----
     While a drag is in flight the element must not fight the reader
     for the handle, so timeupdate stops writing to the input until
     the drag commits. */
  ui.range.addEventListener('pointerdown', () => { seeking = true; });

  ui.range.addEventListener('input', () => {
    seeking = true;
    fill(ui.range);
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      ui.now.textContent = clock((Number(ui.range.value) / 1000) * audio.duration);
    }
  });

  ui.range.addEventListener('change', () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = (Number(ui.range.value) / 1000) * audio.duration;
    }
    seeking = false;
  });

  /* ---- Volume ---- */
  ui.volume.addEventListener('input', () => {
    level = Number(ui.volume.value) / 100;
    audio.volume = level;
    setMuted(level === 0);
    paintVolume();
    try { localStorage.setItem(VOL_KEY, String(level)); } catch { /* refused */ }
  });

  ui.mute.addEventListener('click', () => {
    setMuted(!audio.muted);
    paintVolume();
  });

  /* ---- Keys, but only ours ----
     app.js and playlists.js own the page's keyboard. The player takes
     keys only while focus is inside it, so nothing here can steal "/"
     from the search box or space from the page scroll. */
  ui.bar.addEventListener('keydown', (event) => {
    if ((event.target.tagName || '').toLowerCase() === 'input') return;

    if (event.key === ' ' || event.key === 'k') {
      event.preventDefault();
      toggle();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      next();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      previous();
    }
  });

  /* ---- The elements themselves ----
     Both are bound the same way, and every handler first checks that
     the event is the live element's: the one fading out is still
     playing, pausing and ending, and none of that is the bar's
     business. */
  bindElement(audio);

  // A navigation, or the window closing, is the last chance to record
  // where we were. Both are listened for: which of them WebView2 fires
  // on the way out has not been measured, and the timeupdate write
  // above is at most a second behind either way.
  const last = () => {
    tick();
    flushListened();
    saveResume();
  };
  window.addEventListener('pagehide', last);
  window.addEventListener('beforeunload', last);

  wireMediaSession();
}

/** Bind the playback events to one <audio> element. */
function bindElement(el) {
  el.addEventListener('play', () => {
    if (el !== audio) return;
    lastPos = audio.currentTime || 0;
    logStart();
    lab.fx.resume();
    paintPlaying(true);
    saveResume();
  });

  // The incoming song is making sound: the overlap is timed from here
  el.addEventListener('playing', () => {
    if (el !== audio) return;
    rampStart();
  });

  el.addEventListener('pause', () => {
    if (el !== audio) return;
    pausedAt = Date.now();
    // A pause in the middle of a fade stops both
    finishFade();
    tick();
    flushListened();
    paintPlaying(false);
    saveResume();
  });

  el.addEventListener('loadedmetadata', () => {
    if (el !== audio) return;
    clearApiTimer();
    paintTimes();
    ui.range.disabled = !(Number.isFinite(audio.duration) && audio.duration > 0);
    // The duration has arrived: the bar on Discord can have an end now
    presenceSync();
  });

  // A seek moves the elapsed time Discord is counting from, and is a
  // position worth keeping straight away
  el.addEventListener('seeked', () => {
    if (el !== audio) return;
    presenceSync();
    saveResume();
  });

  el.addEventListener('timeupdate', () => {
    if (el !== audio) return;
    if (!seeking && Number.isFinite(audio.duration) && audio.duration > 0) {
      ui.range.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
      fill(ui.range);
    }
    paintTimes();
    tick();

    const now = Date.now();
    if (now - lastWrite > RESUME_EVERY) {
      lastWrite = now;
      saveResume();
      flushListened();
    }

    maybeCrossfade();
  });

  el.addEventListener('ended', () => {
    if (el !== audio) return;
    tick();
    flushListened();

    // "Stop after this song": it ends here, whatever was due next
    if (sleep.mode === 'song') {
      clearSleepTimers();
      sleep.mode = null;
      sleep.until = 0;
      note('Sleep timer: stopped after this song');
      sleepChanged();
      paintPlaying(false);
      ui.range.value = '0';
      fill(ui.range);
      presenceSync();
      return;
    }

    if (state.repeat === 'one') {
      // Around again is another play of the same track
      playId = null;
      lastPos = 0;
      audio.currentTime = 0;
      audio.play().catch(() => paintPlaying(false));
      return;
    }

    // The Vault is a pile, not a running order: reaching the end of a
    // track there is the end of it. Repeat-all is the reader asking
    // for something else, so that keeps going, and so does a queue.
    if (state.context === 'vault' && state.repeat !== 'all' && !state.queue.length) {
      paintPlaying(false);
      ui.range.value = '0';
      fill(ui.range);
      // Ended is not paused: nothing to count up from, so it comes down
      presenceSync();
      return;
    }

    next({ auto: true });
  });

  el.addEventListener('error', () => {
    // The element that was fading out is emptied on purpose
    if (el !== audio) return;
    // stop() clears the source on purpose, and that fires this too
    if (!audio.getAttribute('src')) return;

    if (state.source === 'api') {
      // No file here, and the archive said no, or could not be reached,
      // or the id is not one it knows. Same end state either way, and
      // never a bar that looks like it is about to play.
      apiFailed('Not saved here, and the archive could not stream it');
      return;
    }

    ui.bar.classList.add('is-missing');
    ui.sub.textContent = 'That file would not play';
    paintPlaying(false);
  });
}

/* ---------- Boot ---------- */

/**
 * Start the player for a page.
 *
 * Called by app.js and playlists.js. Safe to call before the
 * catalogue arrives: it only warms the exclusion queue and puts back
 * whatever the previous page was playing.
 */
export function initPlayer() {
  // Framed: the shell mounted the bar and owns the element already
  if (HOST) return Promise.resolve();
  mount();
  loadIndex();
  return loadSettings().then(loadRecent).then(restore);
}
