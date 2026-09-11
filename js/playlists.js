/* ============================================================
   Playlists entry point.

   The counterpart to app.js: it owns the state, the events and the
   boot for playlists.html, and everything it draws comes out of db.js.
   It never calls the archive. A saved item carries its own copy of the
   track fields, so this page is fully usable with the network off.

   One list is selected at a time. Every action writes first and then
   redraws from what the database returns, so the screen cannot drift
   out of step with what is actually stored.

   The hero takes its colour from the playlist's own first cover, via
   coverSpec(). That is the same per-title palette the artwork uses, so
   the chrome and the art can never disagree. It is derived from the
   title hash, not sampled from the image: reading pixels back out of a
   CDN image would need a canvas and a CORS round trip for no real gain.
   ============================================================ */

import { make, niceDate, group, seconds, clock } from './utils.js';
import { buildCover, buildAssignments, coverSpec } from './covers.js';
import { swatchFor } from './ui.js';
import {
  initPlayer, playFromPlaylist, toggleShuffle, isShuffled
} from './player.js';
import {
  listPlaylists, createPlaylist, updatePlaylist, deletePlaylist,
  itemsIn, removeItem, moveItem, exportAll, importAll
} from './db.js';

/* ---------- Element refs ---------- */
const el = {};

[
  'plStatus', 'plHero', 'plHeroArt', 'plKind', 'plTitle', 'plLede', 'plStats',
  'plFigs', 'plFigLists', 'plFigTracks', 'plActs', 'plEditBtn',
  'plPlay', 'plShuffle',
  'plSideN', 'plLists', 'plListsEmpty', 'plNewForm', 'plNewName',
  'plPane', 'plBlank', 'plForm', 'plName', 'plNoteField', 'plFormCancel',
  'plDelete', 'plRowsHead', 'plRows', 'plRowsEmpty', 'plExport', 'plImport'
].forEach((id) => { el[id] = document.getElementById(id); });

/* ---------- State ---------- */
let lists = [];
let items = [];
let currentId = null;

/** Set while the delete button is armed, so one stray click cannot
    destroy a list. Cleared on a timer. */
let deleteArmed = null;

function say(text) {
  el.plStatus.textContent = text || '';
}

function current() {
  return lists.find((p) => p.id === currentId) || null;
}

/* ---------- Icons ---------- */
const NS = 'http://www.w3.org/2000/svg';

function icon(d) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  return svg;
}

const UP = 'M12 19V5M5 12l7-7 7 7';
const DOWN = 'M12 5v14M19 12l-7 7-7-7';
const CROSS = 'M6 6l12 12M18 6L6 18';

/** Filled, unlike the others: a stroked triangle at this size reads
    as a smudge rather than a play button. */
function playIcon() {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M8 5.14v13.72a1 1 0 0 0 1.5.86l11.14-6.86a1 1 0 0 0 0-1.72L9.5 4.28A1 1 0 0 0 8 5.14z');
  svg.appendChild(path);
  return svg;
}

/**
 * Start the selected playlist at one row.
 *
 * The whole list goes to the player, not just the track, because the
 * running order is the point of this context: it needs somewhere to
 * advance to when the track ends.
 */
function playAt(index) {
  if (!currentId || !items.length) return;
  playFromPlaylist(currentId, items, index);
}

/* ---------- Cover mosaic ----------
   Up to four covers stacked into one square. The cell count goes on
   data-n so the CSS can lay out one, two, three or four without the
   odd ones looking like a broken grid. */
function mosaic(node, rows) {
  node.textContent = '';
  const picks = rows.slice(0, 4);
  node.dataset.n = String(picks.length);

  picks.forEach((item) => {
    const cell = make('span', 'mos-cell');
    cell.appendChild(buildCover(item));
    node.appendChild(cell);
  });

  // Nothing saved yet: the 999 mark stands in for the artwork
  if (!picks.length) node.appendChild(make('span', 'mos-mark', '999'));
}

/** The palette of a playlist's first cover, as [base, mid, detail]. */
function paletteOf(rows) {
  return rows.length ? coverSpec(rows[0].t).pal : null;
}

/* ---------- Hero ---------- */
function renderHero() {
  const list = current();

  if (!list) {
    el.plHero.dataset.mode = 'empty';
    el.plHero.style.removeProperty('--wash');
    el.plHero.style.removeProperty('--wash-2');
    el.plKind.textContent = 'Your library';
    el.plTitle.textContent = 'Playlists';
    el.plLede.hidden = false;
    el.plLede.textContent = 'Your own running order over the archive. Add a track from any card in the Vault, arrange it here, and it stays put between visits.';
    el.plStats.hidden = true;
    el.plFigs.hidden = false;
    el.plActs.hidden = true;
    mosaic(el.plHeroArt, []);
    document.title = 'Playlists: 999';
    return;
  }

  el.plHero.dataset.mode = 'list';
  el.plKind.textContent = 'Playlist';
  el.plTitle.textContent = list.name;

  el.plLede.hidden = !list.note;
  el.plLede.textContent = list.note || '';

  const total = items.reduce((n, item) => n + seconds(item.len), 0);
  const bits = [items.length === 1 ? '1 track' : `${group(items.length)} tracks`];
  if (total) bits.push(clock(total));
  bits.push(`updated ${niceDate(new Date(list.updated).toISOString().slice(0, 10))}`);

  el.plStats.hidden = false;
  el.plStats.textContent = bits.join('  ·  ');
  el.plFigs.hidden = true;
  el.plActs.hidden = false;

  // Nothing to play in an empty list, and the shuffle flag is the
  // player's, so the button is drawn from it rather than from a
  // second copy kept here.
  el.plPlay.disabled = items.length === 0;
  el.plShuffle.disabled = items.length === 0;
  el.plShuffle.setAttribute('aria-pressed', String(isShuffled()));
  el.plShuffle.classList.toggle('is-on', isShuffled());

  mosaic(el.plHeroArt, items);

  // The wash is the art's own palette, so the band under a playlist is
  // always a shade of the covers sitting on top of it.
  const pal = paletteOf(items);
  if (pal) {
    el.plHero.style.setProperty('--wash', pal[1]);
    el.plHero.style.setProperty('--wash-2', pal[0]);
  } else {
    el.plHero.style.removeProperty('--wash');
    el.plHero.style.removeProperty('--wash-2');
  }

  document.title = `${list.name} · Playlists: 999`;
}

/* ---------- Library rail ---------- */
function renderLists() {
  el.plLists.textContent = '';

  lists.forEach((list) => {
    const li = document.createElement('li');

    const btn = make('button', 'pl-card');
    btn.type = 'button';
    btn.setAttribute('aria-current', list.id === currentId ? 'true' : 'false');

    // The rail shows the selected list's real covers. The others would
    // each need their own read, so they carry the generated mark.
    const art = make('span', 'pl-card-art');
    if (list.id === currentId && items.length) {
      mosaic(art, items);
    } else {
      art.dataset.n = '0';
      art.appendChild(make('span', 'mos-mark', '999'));
    }
    btn.appendChild(art);

    const body = make('span', 'pl-card-body');
    body.appendChild(make('span', 'pl-card-name', list.name));

    const sub = make('span', 'pl-card-sub');
    sub.appendChild(make('span', 'pl-card-n', list.n === 1 ? '1 track' : `${group(list.n)} tracks`));
    body.appendChild(sub);
    btn.appendChild(body);

    btn.addEventListener('click', () => select(list.id));

    li.appendChild(btn);
    el.plLists.appendChild(li);
  });

  el.plLists.hidden = lists.length === 0;
  el.plListsEmpty.hidden = lists.length !== 0;

  const tracks = lists.reduce((n, p) => n + p.n, 0);
  el.plFigLists.textContent = group(lists.length);
  el.plFigTracks.textContent = group(tracks);
  el.plSideN.textContent = lists.length
    ? `${group(lists.length)} / ${group(tracks)}`
    : '';
}

/* ---------- Tracklist ---------- */
function buildRow(item, index) {
  const li = make('li', 'pl-row');
  li.style.setProperty('--swatch', swatchFor(item.c));

  li.appendChild(make('span', 'pl-pos mono', String(index + 1).padStart(2, '0')));

  const shot = make('span', 'pl-shot');
  shot.appendChild(buildCover(item));

  // Safe to nest here, unlike the Vault: a playlist row is an <li> of
  // spans, not a <button>, so this is not a button inside a button.
  const play = make('button', 'pl-play');
  play.type = 'button';
  play.appendChild(playIcon());
  play.appendChild(make('span', 'sr-only', `Play ${item.t}`));
  play.addEventListener('click', () => playAt(index));
  shot.appendChild(play);

  li.appendChild(shot);

  const body = make('span', 'pl-body');
  body.appendChild(make('span', 'pl-title-t', item.t));
  if (item.a.length) {
    body.appendChild(make('span', 'pl-alts', item.a.join('  ·  ')));
  } else if (item.sz) {
    body.appendChild(make('span', 'pl-alts', item.sz));
  }
  li.appendChild(body);

  const cat = make('span', 'pl-cat');
  cat.appendChild(make('span', 'dot'));
  cat.appendChild(document.createTextNode(item.c));
  li.appendChild(cat);

  li.appendChild(make('span', 'pl-len mono', item.len || ''));

  const acts = make('span', 'pl-acts');

  const up = make('button', 'pl-act');
  up.type = 'button';
  up.dataset.dir = 'up';
  up.disabled = index === 0;
  up.appendChild(icon(UP));
  up.appendChild(make('span', 'sr-only', `Move ${item.t} up`));
  up.addEventListener('click', () => shift(item.id, -1));

  const down = make('button', 'pl-act');
  down.type = 'button';
  down.dataset.dir = 'down';
  down.disabled = index === items.length - 1;
  down.appendChild(icon(DOWN));
  down.appendChild(make('span', 'sr-only', `Move ${item.t} down`));
  down.addEventListener('click', () => shift(item.id, 1));

  const cut = make('button', 'pl-act pl-act-cut');
  cut.type = 'button';
  cut.appendChild(icon(CROSS));
  cut.appendChild(make('span', 'sr-only', `Remove ${item.t} from this playlist`));
  cut.addEventListener('click', () => dropItem(item));

  acts.appendChild(up);
  acts.appendChild(down);
  acts.appendChild(cut);
  li.appendChild(acts);

  return li;
}

function renderRows() {
  // Deal the generated compositions across this playlist rather than
  // the whole catalogue, so a short list still gets a spread instead of
  // the same layout three times over. Must run before coverSpec() is
  // read for the hero wash.
  buildAssignments(items);

  el.plRows.textContent = '';
  const frag = document.createDocumentFragment();
  items.forEach((item, i) => frag.appendChild(buildRow(item, i)));
  el.plRows.appendChild(frag);

  el.plRows.hidden = items.length === 0;
  el.plRowsHead.hidden = items.length === 0;
  el.plRowsEmpty.hidden = items.length !== 0;
}

/* ---------- Detail pane ---------- */
function renderPane() {
  const list = current();

  el.plPane.hidden = !list;
  el.plBlank.hidden = Boolean(list);

  if (!list) {
    items = [];
    closeForm();
    renderHero();
    return;
  }

  el.plName.value = list.name;
  el.plNoteField.value = list.note || '';
  disarmDelete();
  renderRows();
  renderHero();
}

/* ---------- Edit form ---------- */
function openForm() {
  el.plForm.hidden = false;
  el.plEditBtn.setAttribute('aria-expanded', 'true');
  el.plName.focus();
  el.plName.select();
}

function closeForm() {
  el.plForm.hidden = true;
  el.plEditBtn.setAttribute('aria-expanded', 'false');
  disarmDelete();
}

function toggleForm() {
  if (el.plForm.hidden) openForm();
  else { closeForm(); el.plEditBtn.focus(); }
}

/* ---------- Actions ---------- */
async function select(id) {
  currentId = id;

  try {
    items = await itemsIn(id);
  } catch (err) {
    items = [];
    say(err.message || 'Those tracks could not be read');
  }
  closeForm();
  renderPane();
  renderLists();
}

/** Reload the rail, keeping the selection if it still exists. */
async function refreshLists() {
  lists = await listPlaylists();
  if (!lists.some((p) => p.id === currentId)) {
    currentId = lists.length ? lists[0].id : null;
  }
  renderLists();
}

async function makeList(event) {
  event.preventDefault();

  const name = el.plNewName.value.trim();
  if (!name) {
    say('Give the playlist a name first');
    el.plNewName.focus();
    return;
  }

  try {
    const list = await createPlaylist(name);
    el.plNewName.value = '';
    await refreshLists();
    await select(list.id);
    say(`Created ${list.name}`);
  } catch (err) {
    say(err.message || 'That playlist could not be created');
  }
}

async function saveMeta(event) {
  event.preventDefault();
  if (!currentId) return;

  try {
    const row = await updatePlaylist(currentId, {
      name: el.plName.value,
      note: el.plNoteField.value
    });
    await refreshLists();
    renderHero();
    closeForm();
    el.plEditBtn.focus();
    say(row ? `Saved ${row.name}` : 'That playlist is no longer there');
  } catch (err) {
    say(err.message || 'Those details could not be saved');
  }
}

function disarmDelete() {
  clearTimeout(deleteArmed);
  deleteArmed = null;
  el.plDelete.classList.remove('is-armed');
  el.plDelete.textContent = 'Delete playlist';
}

/**
 * Two presses to delete.
 * Deleting takes every track in the list with it and there is no undo,
 * so the first press only arms the button. It disarms itself after a
 * few seconds, and editing the name disarms it too.
 */
async function askDelete() {
  if (!currentId) return;

  if (!deleteArmed) {
    el.plDelete.classList.add('is-armed');
    el.plDelete.textContent = 'Press again to delete';
    say('That removes the playlist and everything in it. There is no undo.');
    deleteArmed = setTimeout(disarmDelete, 5000);
    return;
  }

  const list = current();
  const name = list ? list.name : 'that playlist';
  const doomed = currentId;
  disarmDelete();

  try {
    await deletePlaylist(doomed);
    currentId = null;
    items = [];
    await refreshLists();
    if (currentId) await select(currentId); else renderPane();
    say(`Deleted ${name}`);
  } catch (err) {
    say(err.message || 'That playlist could not be deleted');
  }
}

async function dropItem(item) {
  try {
    await removeItem(item.id);
    items = await itemsIn(currentId);
    await refreshLists();
    renderRows();
    renderHero();
    say(`Removed ${item.t}`);
  } catch (err) {
    say(err.message || 'That track could not be removed');
  }
}

/**
 * Move a row, then put focus back on the button that moved it, which is
 * now one place along. Without that, every press drops focus to the
 * body and a row cannot be walked up the list from the keyboard.
 */
async function shift(itemId, delta) {
  try {
    if (!await moveItem(currentId, itemId, delta)) return;

    items = await itemsIn(currentId);
    renderRows();
    renderHero();

    const row = el.plRows.children[items.findIndex((r) => r.id === itemId)];
    if (!row) return;

    const button = row.querySelector(`.pl-act[data-dir="${delta < 0 ? 'up' : 'down'}"]`);
    // Disabled at the end of the list: fall back to the other direction
    if (button && !button.disabled) button.focus();
    else row.querySelector('.pl-act:not([disabled])')?.focus();
  } catch (err) {
    say(err.message || 'That track could not be moved');
  }
}

/* ---------- Backup ---------- */

/**
 * IndexedDB lives in one browser profile, and clearing site data takes
 * it with everything else. An export is the only copy that survives
 * that, so it is on the page rather than buried.
 */
async function doExport() {
  try {
    const payload = await exportAll();
    if (!payload.playlists.length) {
      say('There is nothing to export yet');
      return;
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `999-playlists-${payload.exported.slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    // Revoked on a timer: revoking in the same tick cancels the download
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    say(`Exported ${group(payload.playlists.length)} playlists`);
  } catch (err) {
    say(err.message || 'The export failed');
  }
}

async function doImport(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    const added = await importAll(JSON.parse(await file.text()));
    await refreshLists();
    if (currentId) await select(currentId); else renderPane();
    say(`Imported ${group(added.playlists)} playlists and ${group(added.items)} tracks`);
  } catch (err) {
    say(err.message || 'That file could not be read');
  } finally {
    // Cleared so picking the same file again still fires a change
    event.target.value = '';
  }
}

/* ---------- Events ---------- */
/* Play from the top of the list, in whatever order shuffle has set */
el.plPlay.addEventListener('click', () => playAt(0));

/* Shuffle can be armed with nothing playing, so pressing it on a
   stopped playlist sets the order and starts it. */
el.plShuffle.addEventListener('click', () => {
  const on = toggleShuffle();
  el.plShuffle.setAttribute('aria-pressed', String(on));
  el.plShuffle.classList.toggle('is-on', on);
  if (on && items.length) playAt(0);
});

el.plNewForm.addEventListener('submit', makeList);
el.plForm.addEventListener('submit', saveMeta);
el.plEditBtn.addEventListener('click', toggleForm);
el.plFormCancel.addEventListener('click', () => { closeForm(); el.plEditBtn.focus(); });
el.plDelete.addEventListener('click', askDelete);
el.plExport.addEventListener('click', doExport);
el.plImport.addEventListener('change', doImport);

// Arming the delete and then editing the name is a change of mind
el.plName.addEventListener('input', disarmDelete);

// Escape closes the edit panel rather than leaving it hanging open
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el.plForm.hidden) {
    closeForm();
    el.plEditBtn.focus();
  }
});

/* ---------- Boot ---------- */
async function boot() {
  // Puts the bar back if a track was playing on the way in from the
  // Vault. Not awaited: the rail should not wait on the audio index.
  initPlayer();

  try {
    await refreshLists();
    if (currentId) await select(currentId); else renderPane();
  } catch (err) {
    el.plListsEmpty.hidden = false;
    renderPane();
    say(err.message || 'Playlists are unavailable in this browser');
  }
}

boot();
