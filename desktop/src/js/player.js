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
   survive a reload. Volume does not, and lives in localStorage. The
   resume snapshot lives in sessionStorage: these are separate pages,
   not routes, so an <audio> element cannot survive a navigation and
   the state is rebuilt on the other side instead.
   ============================================================ */

import { API_BASE } from './config.js';
import { invoke, loadArchive, resolveAudio, inTauri } from './tauri.js';
import { make, clock } from './utils.js';
import { buildCover, coverSpec } from './covers.js';
import { swatchFor } from './ui.js';
import { pushRecent, recentIds, itemsIn, logPlay, addListened } from './db.js';

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

/** The resume snapshot. sessionStorage, not localStorage: it is scoped
    to this tab and is meant to die with it. */
const RESUME_KEY = '999:nowplaying';

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
    Every timeupdate would be four writes a second for no benefit. */
const RESUME_EVERY = 3000;

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

/** The record id for a track, falling back to its title for playlist
    items saved before `rid` existed. */
function ridFor(track) {
  if (!track) return null;
  if (track.rid && byId.has(track.rid)) return track.rid;
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

/** The archive did not deliver: no file here, and no stream either. */
function apiFailed(reason) {
  clearApiTimer();
  audio.pause();
  audio.removeAttribute('src');
  ui.bar.classList.add('is-missing');
  ui.range.disabled = true;
  ui.origin.hidden = true;
  ui.sub.textContent = reason;
  if (state.track) ui.status.textContent = `${state.track.t}: ${reason}`;
  paintPlaying(false);
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

const audio = new Audio();
audio.preload = 'metadata';

/** Read the saved volume before the first track, so the first play is
    not full blast. A private window can refuse storage outright. */
try {
  const saved = parseFloat(localStorage.getItem(VOL_KEY));
  audio.volume = Number.isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 0.8;
} catch {
  audio.volume = 0.8;
}

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

  const pos = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  shown.start = now - Math.floor(pos);
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    shown.end = shown.start + Math.round(audio.duration);
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
  if (!inTauri || HOST) return;
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

  ui.shot = make('span', 'mini-shot');
  who.appendChild(ui.shot);

  const text = make('span', 'mini-text');
  ui.title = make('span', 'mini-title');
  ui.sub = make('span', 'mini-sub');
  // Plain text, not an icon: it has to be obvious at a glance that this
  // track is coming over the network rather than from disk.
  ui.origin = make('span', 'mini-origin', 'via API');
  ui.origin.hidden = true;
  text.appendChild(ui.title);
  text.appendChild(ui.sub);
  text.appendChild(ui.origin);
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

  /* ---- Volume and dismiss ---- */
  const side = make('div', 'mini-side');

  ui.mute = control('mini-btn mini-vol-btn', 'Mute', icon(...VOL));
  side.appendChild(ui.mute);

  ui.volume = make('input', 'mini-range mini-volume');
  ui.volume.type = 'range';
  ui.volume.min = '0';
  ui.volume.max = '100';
  ui.volume.step = '1';
  ui.volume.value = String(Math.round(audio.volume * 100));
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
  const muted = audio.muted || audio.volume === 0;
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
  if (state.context === 'playlist' && state.list.length) {
    bits.push(`${state.cursor + 1} of ${state.list.length}`);
  }
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
  let pool;
  try { pool = vaultPool().filter(hasAudio); } catch { pool = []; }
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

/* ---------- Loading ---------- */

/**
 * Point the element at a track and, unless told otherwise, play it.
 *
 * Returns false when the track has no file: the bar says so and stays
 * on screen rather than throwing inside a click handler.
 */
async function load(track, { autoplay = true, at = 0, resumeId = null } = {}) {
  await loadIndex();
  clearApiTimer();

  // Close the book on whatever was playing before the switch. A track
  // resumed from the previous page keeps the row it already had, so a
  // navigation mid-track is one play, not two.
  tick();
  flushListened();
  playId = resumeId || null;
  logging = false;
  lastPos = at > 0 ? at : 0;
  unflushed = 0;

  // The file on disk first, always. The archive's stream is only ever a
  // fallback for a track that was never pulled, and it must not be
  // preferred for one that was.
  const local = srcFor(track);
  const src = local || apiSrcFor(track);
  state.source = local ? 'local' : (src ? 'api' : null);
  state.track = track;

  mount();
  ui.bar.hidden = false;
  document.body.classList.add('has-player');
  paintTrack();
  paintContext();
  paintOrigin();
  // The track has changed even though nothing is playing yet: the
  // pages move their mark now and the play event lights it up.
  notify();

  if (!src) {
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
  audio.src = src;

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
  return load(track);
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

  const pick = randomTrack();
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
    state.cursor = state.cursor > 0 ? state.cursor - 1 : state.order.length - 1;
    load(state.list[state.order[state.cursor]]);
    return;
  }

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
}

/** Stop and put the bar away. The audio is released, not just paused. */
export function stop() {
  if (HOST) { HOST.stop(); return; }
  tick();
  flushListened();
  playId = null;
  audio.pause();
  audio.removeAttribute('src');
  // Releases the buffered file rather than leaving the element holding
  // it. It fires an error event with no source, which the handler
  // below already stands aside for.
  audio.load();
  clearApiTimer();
  state.track = null;
  state.source = null;
  state.history = [];
  if (mounted) {
    ui.bar.hidden = true;
    paintOrigin();
    paintPlaying(false);
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
    sessionStorage.setItem(RESUME_KEY, JSON.stringify({
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
    // survive the next navigation.
  }
}

function clearResume() {
  try { sessionStorage.removeItem(RESUME_KEY); } catch { /* refused */ }
}

/**
 * Pick up where the last page left off.
 *
 * Autoplay is attempted only if it was playing, and a refusal is
 * expected: the click that started it belonged to the page before
 * this one, so the gesture does not carry over. Failing lands on a
 * loaded, seeked, paused track, which is one keypress from right.
 */
async function restore() {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(RESUME_KEY) || 'null');
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
    autoplay: !saved.paused,
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
    audio.volume = Number(ui.volume.value) / 100;
    audio.muted = audio.volume === 0;
    paintVolume();
    try { localStorage.setItem(VOL_KEY, String(audio.volume)); } catch { /* refused */ }
  });

  ui.mute.addEventListener('click', () => {
    audio.muted = !audio.muted;
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

  /* ---- The element itself ---- */
  audio.addEventListener('play', () => {
    lastPos = audio.currentTime || 0;
    logStart();
    paintPlaying(true);
    saveResume();
  });

  audio.addEventListener('pause', () => {
    pausedAt = Date.now();
    tick();
    flushListened();
    paintPlaying(false);
    saveResume();
  });

  audio.addEventListener('loadedmetadata', () => {
    clearApiTimer();
    paintTimes();
    ui.range.disabled = !(Number.isFinite(audio.duration) && audio.duration > 0);
    // The duration has arrived: the bar on Discord can have an end now
    presenceSync();
  });

  // A seek moves the elapsed time Discord is counting from
  audio.addEventListener('seeked', presenceSync);

  audio.addEventListener('timeupdate', () => {
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
  });

  audio.addEventListener('ended', () => {
    tick();
    flushListened();

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
    // for something else, so that keeps going.
    if (state.context === 'vault' && state.repeat !== 'all') {
      paintPlaying(false);
      ui.range.value = '0';
      fill(ui.range);
      // Ended is not paused: nothing to count up from, so it comes down
      presenceSync();
      return;
    }

    next({ auto: true });
  });

  audio.addEventListener('error', () => {
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

  // A navigation is the last chance to record where we were
  window.addEventListener('pagehide', () => {
    tick();
    flushListened();
    saveResume();
  });

  wireMediaSession();
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
  return loadRecent().then(restore);
}
