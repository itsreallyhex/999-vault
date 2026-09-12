/* ============================================================
   The overview.

   Entry point for index.html and nothing else. The window opens on
   this page: a hero washed with the most played track's own palette,
   the listening figures, the most played tracks as a tracklist,
   three small readings, and the two doors into the Vault and the
   playlists.

   Every figure is computed from the `plays` store, which the player
   writes one row per track started. Nothing here is typed in and
   nothing reaches the archive: the catalogue is read once, from disk
   through Rust, for the size of the main archive and nothing else.

   This is not home.js. That file drew the site's landing page, with
   its mosaic, its strip and its live figures, and it did not come
   across. Nothing here is ported from it.
   ============================================================ */

import { OWNER } from './config.js';
import { invoke, loadArchive, archiveInfo } from './tauri.js';
import { make, group, niceDate } from './utils.js';
import { buildCover, buildAssignments, coverSpec } from './covers.js';
import { swatchFor } from './ui.js';
import { allPlays, listPlaylists } from './db.js';
import {
  initPlayer, playTrack, toggle, onPlayback, sameTrack
} from './player.js';
import { computeStats, spanText, hourText } from './stats.js';

/** How many tracks the most-played list shows. */
const MOST = 8;

/* ---------- Element refs ---------- */
const el = {};

[
  'ovHero', 'ovHeroArt', 'greet', 'ovLede',
  'figPlays', 'figTime', 'figStreak', 'figUnique',
  'topN', 'topHead', 'topRows', 'topEmpty',
  'compRing', 'compPct', 'compPlayed', 'compNote',
  'hourBars', 'hourNote', 'dayStrip', 'streakBest', 'daysPlayed', 'avgDaily',
  'figVault', 'figPlaylists', 'status'
].forEach((id) => { el[id] = document.getElementById(id); });

/* ---------- State ---------- */

/** The rows on screen, in list order, so the now-playing mark can be
    matched by index the way playlists.js does it. */
let top = [];

/** What the player last reported. */
let now = { track: null, playing: false };

function say(text, state) {
  if (!el.status) return;
  el.status.textContent = text;
  if (state) el.status.dataset.state = state; else delete el.status.dataset.state;
}

/* ---------- Icons ---------- */
const NS = 'http://www.w3.org/2000/svg';
const PLAY = 'M8 5.14v13.72a1 1 0 0 0 1.5.86l11.14-6.86a1 1 0 0 0 0-1.72L9.5 4.28A1 1 0 0 0 8 5.14z';
const PAUSE = 'M7 4h3.4v16H7zM13.6 4H17v16h-3.4z';

function solidIcon(cls, d) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  return svg;
}

function markSvg() {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'mark');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', '#mark999');
  svg.appendChild(use);
  return svg;
}

function eqBars() {
  const eq = make('span', 'pl-eq');
  eq.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) eq.appendChild(make('i'));
  return eq;
}

/* ---------- Playing ---------- */

/** A play row back into the shape the player takes. The snapshot
    carries no alternate names or length; the bar copes without. */
function trackOf(entry) {
  return { rid: entry.rid, t: entry.t, a: [], c: entry.c, cov: entry.cov, len: '' };
}

/** The row that is already loaded pauses or resumes; any other
    starts. Same rule as the playlists page. */
function playAt(index) {
  const entry = top[index];
  if (!entry) return;
  if (now.track && sameTrack(entry, now.track)) toggle();
  else playTrack(trackOf(entry));
}

function markPlaying() {
  const rows = el.topRows.children;
  top.forEach((entry, i) => {
    const row = rows[i];
    if (!row) return;
    const cur = Boolean(now.track) && sameTrack(entry, now.track);
    const playing = cur && now.playing;
    row.classList.toggle('is-current', cur);
    row.classList.toggle('is-playing', playing);
    if (cur) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
    const label = row.querySelector('.pl-go .sr-only');
    if (label) label.textContent = `${playing ? 'Pause' : 'Play'} ${entry.t}`;
  });
}

/* ---------- Hero ---------- */

/** Up to four covers in one square, the cell count on data-n so one,
    two and three lay out on purpose. The same mosaic the playlists
    hero draws. */
function mosaic(node, entries) {
  node.textContent = '';
  const picks = entries.slice(0, 4);
  node.dataset.n = String(picks.length);
  picks.forEach((entry) => {
    const cell = make('span', 'mos-cell');
    cell.appendChild(buildCover(entry));
    node.appendChild(cell);
  });
  if (!picks.length) {
    const mark = make('span', 'mos-mark');
    mark.appendChild(markSvg());
    node.appendChild(mark);
  }
}

function renderHero(stats) {
  const has = stats.total > 0;
  el.ovHero.dataset.mode = has ? 'list' : 'empty';
  el.greet.textContent = OWNER ? `Hey, ${OWNER}` : 'Hey';

  if (has) {
    const bits = [
      `${group(stats.total)} ${stats.total === 1 ? 'play' : 'plays'} across ${group(stats.days)} ${stats.days === 1 ? 'day' : 'days'}`
    ];
    if (stats.firstAt) bits.push(`listening since ${niceDate(new Date(stats.firstAt).toISOString().slice(0, 10))}`);
    el.ovLede.textContent = bits.join(', ') + '.';
  } else {
    el.ovLede.textContent = 'Nothing played yet. Press play on anything in the Vault and this page fills in from there.';
  }

  el.figPlays.textContent = group(stats.total);
  el.figTime.textContent = spanText(stats.seconds);
  el.figStreak.textContent = `${stats.streak.current}d`;
  el.figUnique.textContent = group(stats.unique);

  mosaic(el.ovHeroArt, top);

  // The band takes the palette of the most played track's own cover,
  // the same way the playlists hero takes its first track's.
  const pal = top.length ? coverSpec(top[0].t).pal : null;
  if (pal) {
    el.ovHero.style.setProperty('--wash', pal[1]);
    el.ovHero.style.setProperty('--wash-2', pal[0]);
  } else {
    el.ovHero.style.removeProperty('--wash');
    el.ovHero.style.removeProperty('--wash-2');
  }
}

/* ---------- Most played ---------- */

function buildRow(entry, index, max) {
  const li = make('li', 'pl-row ov-top-row');
  li.style.setProperty('--swatch', swatchFor(entry.c));
  // The share bar behind the row: this track's plays against the top one
  li.style.setProperty('--p', `${max ? (entry.n / max) * 100 : 0}%`);

  const pos = make('span', 'pl-pos mono');
  pos.appendChild(make('span', 'pl-num', String(index + 1).padStart(2, '0')));
  pos.appendChild(eqBars());
  const play = make('button', 'pl-go');
  play.type = 'button';
  play.appendChild(solidIcon('ico-play', PLAY));
  play.appendChild(solidIcon('ico-pause', PAUSE));
  play.appendChild(make('span', 'sr-only', `Play ${entry.t}`));
  play.addEventListener('click', () => playAt(index));
  pos.appendChild(play);
  li.appendChild(pos);

  li.addEventListener('dblclick', (event) => {
    if (event.target.closest('button')) return;
    playAt(index);
  });

  const shot = make('span', 'pl-shot');
  shot.appendChild(buildCover(entry));
  li.appendChild(shot);

  const body = make('span', 'pl-body');
  body.appendChild(make('span', 'pl-title-t', entry.t));
  body.appendChild(make('span', 'pl-alts', entry.rid ? '' : 'saved before records carried an id'));
  li.appendChild(body);

  const cat = make('span', 'pl-cat');
  cat.appendChild(make('span', 'dot'));
  cat.appendChild(document.createTextNode(entry.c));
  li.appendChild(cat);

  li.appendChild(make('span', 'pl-len mono', group(entry.n)));
  li.appendChild(make('span', 'ov-heard mono', spanText(entry.sec)));

  return li;
}

function renderTop(stats) {
  top = stats.mostPlayed.slice(0, MOST);
  // Deal the generated compositions across these few, so two tracks
  // with no artwork do not land on the same layout side by side. Must
  // run before coverSpec() is read for the hero wash.
  buildAssignments(top);

  const max = top.length ? top[0].n : 0;
  el.topRows.textContent = '';
  top.forEach((entry, i) => el.topRows.appendChild(buildRow(entry, i, max)));

  el.topRows.hidden = top.length === 0;
  el.topHead.hidden = top.length === 0;
  el.topEmpty.hidden = top.length !== 0;
  el.topN.textContent = stats.unique
    ? `${group(top.length)} of ${group(stats.unique)}`
    : '';
  markPlaying();
}

/* ---------- The side readings ---------- */

function renderSide(stats) {
  // Completion, as a ring
  if (stats.completion) {
    const { played, total } = stats.completion;
    const pct = total ? Math.round((played / total) * 100) : 0;
    el.compRing.style.setProperty('--p', `${total ? (played / total) * 100 : 0}%`);
    el.compRing.setAttribute('aria-valuenow', String(pct));
    el.compPct.textContent = `${pct}%`;
    el.compPlayed.textContent = group(played);
    el.compNote.textContent = `of ${group(total)} main tracks played`;
  } else {
    el.compPct.textContent = '';
    el.compPlayed.textContent = '';
    el.compNote.textContent = 'The catalogue is not saved to this machine';
  }

  // Plays by hour, twenty-four bars, the peak one lit
  const peak = Math.max(0, ...stats.hours);
  el.hourBars.textContent = '';
  stats.hours.forEach((n, h) => {
    const bar = make('i');
    bar.style.setProperty('--h', `${peak ? (n / peak) * 100 : 0}%`);
    if (n && h === stats.peakHour) bar.classList.add('is-peak');
    el.hourBars.appendChild(bar);
  });
  el.hourNote.textContent = stats.peakHour === null
    ? 'No pattern yet'
    : `Most often around ${hourText(stats.peakHour)}`;

  // The last fourteen days, one square each
  el.dayStrip.textContent = '';
  stats.recentDays.forEach((played, i) => {
    const day = make('i');
    if (played) day.classList.add('is-on');
    if (i === stats.recentDays.length - 1) day.classList.add('is-today');
    el.dayStrip.appendChild(day);
  });
  el.streakBest.textContent = stats.streak.best === 1 ? '1 day' : `${group(stats.streak.best)} days`;
  el.daysPlayed.textContent = group(stats.days);
  el.avgDaily.textContent = group(Math.round(stats.avgDaily));
}

/* ---------- Events ---------- */

onPlayback((snap) => {
  now = snap;
  markPlaying();
});

/* ---------- Boot ---------- */

async function start() {
  el.greet.textContent = OWNER ? `Hey, ${OWNER}` : 'Hey';

  // The archive root has to be known before any cover is drawn: the
  // mosaic and the rows resolve their artwork through it.
  const root = await loadArchive();

  if (!root) {
    const where = archiveInfo()?.config_file;
    say('No archive folder found on this machine. The Vault will ask the '
      + 'live archive instead. Set data_root in '
      + (where || 'the config file') + '.', 'bad');
  } else {
    const bits = [];
    if (!root.covers) bits.push('no covers saved');
    if (!root.audio) bits.push('no audio saved');
    const where = `Archive: ${root.path} (found by ${root.source})`;
    say(bits.length ? `${where} (${bits.join(', ')})` : where);
  }

  // Puts the bar back if a track was playing on the way in. Not
  // awaited: the figures should not wait on the audio index.
  initPlayer();

  // The catalogue is read for two numbers: how many entries there are,
  // and which ids are the main archive, for the completion figure. It
  // is already on disk and already parsed by Rust, so this costs a
  // command and no network.
  let mainIds = null;
  try {
    const snapshot = await invoke('read_catalogue');
    const songs = Array.isArray(snapshot?.songs) ? snapshot.songs : [];
    const count = snapshot?.count ?? songs.length;
    if (count) el.figVault.textContent = `${group(count)} entries`;
    mainIds = new Set(songs.filter((r) => r.category === 'main').map((r) => r.id));
  } catch {
    el.figVault.textContent = 'not saved to this machine';
  }

  try {
    const lists = await listPlaylists();
    if (lists.length === 0) el.figPlaylists.textContent = 'none yet';
    else el.figPlaylists.textContent = lists.length === 1 ? '1 list' : `${group(lists.length)} lists`;
  } catch {
    el.figPlaylists.textContent = '';
  }

  try {
    const stats = computeStats(await allPlays(), { mainIds });
    renderTop(stats);      // deals the cover assignments the hero reads
    renderHero(stats);
    renderSide(stats);
  } catch (err) {
    el.ovLede.textContent = err.message || 'The listening history could not be read';
  }
}

start();
