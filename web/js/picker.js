/* ============================================================
   Add-to-playlist dialog.

   Split out from lightbox.js for the same reason lightbox.js is split
   out of ui.js: it owns focus. It is a native <dialog>, so showModal()
   gives the focus trap, the backdrop and the Escape key for free, and
   the browser hands focus back on close. That is a real trap rather
   than the hand-rolled one in lightbox.js, which predates it.

   This is the only write path on the Vault. Every change goes straight
   to db.js and the row is redrawn from what came back, so the ticks
   always reflect what is actually stored rather than what was clicked.
   ============================================================ */

import { make } from './utils.js';
import { buildCover, coverSpec } from './covers.js';
import { listPlaylists, createPlaylist, addTrack, removeTrack, membership } from './db.js';
import { el, swatchFor } from './ui.js';

/** The track the dialog is currently acting on. */
let track = null;
/** Playlist rows for the open dialog, in list order. */
let lists = [];
/** Playlist ids already holding `track`. */
let inLists = new Set();
/** Only used on the fallback path; a real <dialog> restores focus itself. */
let lastFocus = null;

/** False on any page without the dialog markup, such as playlists.html. */
const present = Boolean(el.picker);

export function isPickerOpen() {
  return present && el.picker.open === true;
}

/**
 * The fallback sets `open` rather than clearing `hidden`: a <dialog>
 * without the open attribute is display:none in the UA stylesheet, so
 * unhiding one shows nothing. It is non-modal, with no backdrop and no
 * trap, which is only ever the jsdom path.
 */
function show() {
  if (typeof el.picker.showModal === 'function') {
    if (!el.picker.open) el.picker.showModal();
  } else {
    el.picker.open = true;
  }
}

function close() {
  if (!present) return;

  if (typeof el.picker.close === 'function' && el.picker.open) {
    el.picker.close();
  } else {
    el.picker.open = false;
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }
  lastFocus = null;
}

/** Status line under the form. Clears when passed nothing. */
function say(text) {
  el.pickerNote.textContent = text || '';
}

/** The checkmark inside a row's box. SVG needs createElementNS. */
function tick() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M20 6L9 17l-5-5');
  svg.appendChild(path);
  return svg;
}

/* ---------- Rendering ---------- */

function buildRow(list) {
  const li = document.createElement('li');

  const btn = make('button', 'pick');
  btn.type = 'button';
  btn.setAttribute('aria-pressed', String(inLists.has(list.id)));

  const box = make('span', 'pick-box');
  box.appendChild(tick());
  btn.appendChild(box);

  const body = make('span', 'pick-body');
  body.appendChild(make('span', 'pick-name', list.name));
  body.appendChild(make('span', 'pick-n', list.n === 1 ? '1 track' : `${list.n} tracks`));
  btn.appendChild(body);

  btn.addEventListener('click', () => toggle(list, btn));

  li.appendChild(btn);
  return li;
}

function renderRows() {
  el.pickerList.textContent = '';
  lists.forEach((list) => el.pickerList.appendChild(buildRow(list)));

  el.pickerList.hidden = lists.length === 0;
  el.pickerEmpty.hidden = lists.length !== 0;
}

/* ---------- Actions ---------- */

/**
 * Add or remove, depending on what the row currently shows.
 * The button is disabled while the write is in flight, so a fast double
 * click cannot fire the add and the remove against the same row.
 */
async function toggle(list, btn) {
  if (!track || btn.disabled) return;
  const had = inLists.has(list.id);

  btn.disabled = true;
  try {
    if (had) {
      await removeTrack(list.id, track.t);
      inLists.delete(list.id);
      list.n = Math.max(0, list.n - 1);
      say(`Removed from ${list.name}`);
    } else {
      const row = await addTrack(list.id, track);
      inLists.add(list.id);
      // null means the unique index rejected it: the track was already
      // there, so the tick is now right but the count must not move.
      if (row) list.n += 1;
      say(row ? `Added to ${list.name}` : `Already in ${list.name}`);
    }
  } catch (err) {
    say(err.message || 'That change could not be saved');
  } finally {
    btn.disabled = false;
    renderRows();
  }
}

/** Create a playlist and drop the current track straight into it. */
async function createAndAdd(event) {
  event.preventDefault();
  if (!track) return;

  const name = el.pickerName.value.trim();
  if (!name) {
    say('Give the playlist a name first');
    el.pickerName.focus();
    return;
  }

  try {
    const list = await createPlaylist(name);
    await addTrack(list.id, track);

    el.pickerName.value = '';
    lists.unshift({ ...list, n: 1 });
    inLists.add(list.id);
    renderRows();
    say(`Added to ${list.name}`);
  } catch (err) {
    say(err.message || 'That playlist could not be created');
  }
}

/* ---------- Open ---------- */

/** Open the dialog for one track. */
export async function openPicker(nextTrack, source) {
  if (!present) return;

  track = nextTrack;
  lastFocus = source || document.activeElement;

  el.pickerTitle.textContent = nextTrack.t;
  el.pickerCat.textContent = nextTrack.c;
  el.picker.style.setProperty('--swatch', swatchFor(nextTrack.c));

  // The record you are filing, shown rather than just named, and the
  // panel tinted with that cover's own palette. Same idea as the
  // playlists hero: the chrome takes its colour from the artwork.
  el.pickerShot.textContent = '';
  el.pickerShot.appendChild(buildCover(nextTrack, { eager: true }));
  el.picker.style.setProperty('--wash', coverSpec(nextTrack.t).pal[1]);

  el.pickerName.value = '';
  say('');

  // Shown before the read, so the dialog is never a blank frame while
  // IndexedDB opens. Both lists start hidden: an empty panel for the
  // half second that takes reads better than an empty-state that
  // flashes up and is immediately replaced.
  lists = [];
  inLists = new Set();
  el.pickerList.textContent = '';
  el.pickerList.hidden = true;
  el.pickerEmpty.hidden = true;
  show();

  try {
    const [all, member] = await Promise.all([listPlaylists(), membership(nextTrack.t)]);
    lists = all;
    inLists = new Set(member);
    renderRows();

    // With no playlists yet, the only useful thing to do is name one
    const first = el.pickerList.querySelector('.pick');
    if (first) first.focus(); else el.pickerName.focus();
  } catch (err) {
    el.pickerEmpty.hidden = false;
    say(err.message || 'Playlists are unavailable in this browser');
  }
}

/* ---------- Wiring ---------- */

if (present) {
  el.pickerClose.addEventListener('click', close);
  el.pickerNew.addEventListener('submit', createAndAdd);

  // A click on the backdrop lands on the dialog itself, not on the panel
  el.picker.addEventListener('click', (event) => {
    if (!event.target.closest('.picker-in')) close();
  });

  el.picker.addEventListener('close', () => {
    track = null;
    lastFocus = null;
  });
}
