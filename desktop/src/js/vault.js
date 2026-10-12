/* ============================================================
   Entry point.

   Owns the view state, the filter/sort pipeline, pagination and all
   event wiring, then hands the results to ui.js to draw. The only
   module index.html loads directly.
   ============================================================ */

import { PAGE_SIZE, SEARCH_DELAY } from './config.js';
import { seconds, bytes, group, debounce, niceDate } from './utils.js';
import { fetchCatalogue } from './api.js';
import { buildAssignments } from './covers.js';
import {
  el, setSource, renderChips,
  renderSkeleton, renderGrid, renderCount
} from './ui.js';
import {
  openLightbox, closeLightbox, isOpen, trapTab, setAddHandler, setPlayHandler
} from './lightbox.js';
import { openPicker, isPickerOpen } from './picker.js';
import {
  initPlayer, playTrack, setVaultPool, toggle, onPlayback, sameTrack, enqueueMany
} from './player.js';
import { createSelect } from './select.js';
import { SEED } from './seed.js';

/* ---------- State ---------- */
let data = [];
let shown = PAGE_SIZE;

const state = { query: '', category: 'all', sort: 'plays', dir: 'desc' };

/** What the player last reported: the loaded track and whether it is
    playing. Kept so a redraw can put the mark back without asking. */
let now = { track: null, playing: false, context: 'vault', playlistId: null };

/* ---------- Filter and sort ---------- */
function matches(track) {
  if (state.category !== 'all' && track.c !== state.category) return false;
  if (!state.query) return true;

  // Alternate titles matter here: the same song circulates under several names
  if (track.t.toLowerCase().includes(state.query)) return true;
  return track.a.some((alt) => alt.toLowerCase().includes(state.query));
}

const SORTERS = {
  title: (a, b) => a.t.localeCompare(b.t),
  length: (a, b) => seconds(a.len) - seconds(b.len),
  size: (a, b) => bytes(a.sz) - bytes(b.sz),
  added: (a, b) => String(a.d).localeCompare(String(b.d)),
  plays: (a, b) => a.p - b.p
};

function visible() {
  const out = data.filter(matches);
  out.sort(SORTERS[state.sort] || SORTERS.plays);
  if (state.dir === 'desc') out.reverse();
  return out;
}

/* ---------- Now playing ---------- */

/**
 * Mark the card holding the loaded track.
 *
 * Cards carry the record id on data-rid, so this is one pass over
 * what is on screen rather than a second run of the filter. A row
 * saved before `rid` existed has nothing to match and gets no mark.
 */
function markPlaying() {
  const rid = now.track && now.track.rid;
  Array.from(el.rows.children).forEach((cell) => {
    const cur = Boolean(rid) && cell.dataset.rid === rid;
    const playing = cur && now.playing;
    cell.classList.toggle('is-current', cur);
    cell.classList.toggle('is-playing', playing);

    const label = cell.querySelector('.card-play .sr-only');
    if (label) {
      label.textContent = `${playing ? 'Pause' : 'Play'} ${label.textContent.replace(/^(Play|Pause) /, '')}`;
    }
  });
}

/** The card's button: a pause on the track that is already loaded,
    whichever page started it, and a fresh start on anything else. */
function playCard(track) {
  if (now.track && sameTrack(track, now.track)) toggle();
  else playTrack(track);
}

/** One line of feedback. The shell draws it over the bar; a bare page
    has nowhere better and stays quiet. */
function say(text) {
  try {
    const up = window.parent !== window && window.parent.__nine_toast;
    if (up) up(text);
  } catch { /* not ours */ }
}

/** The card's queue button: this song, after whatever is waiting.
    Pressing it again queues it again, which is the point. */
function queueCard(track) {
  const waiting = enqueueMany([track]);
  say(waiting ? `${track.t} added to the queue (${waiting} waiting)` : `Playing ${track.t}`);
}

/* ---------- Select mode ----------
   Pick several cards and add them together. In the mode a press on a
   card picks it instead of opening it. Picks are kept by record id, so
   a redraw (a filter, "load more") does not lose them. */

const pickKey = (t) => t.rid || `t:${t.t}`;

const select = createSelect({
  parent: el.sortSelect.parentElement,
  scope: document.body,
  keyOf: pickKey,
  // Queue order is the order on screen
  ordered: () => visible(),
  every: () => visible(),
  onQueue: (list) => enqueueMany(list),
  say
});

function trackOf(cell) {
  const rid = cell.dataset.rid;
  if (rid) return data.find((t) => t.rid === rid) || null;
  const title = cell.querySelector('.card-title');
  return title ? data.find((t) => t.t === title.textContent) || null : null;
}

function markPicked() {
  Array.from(el.rows.children).forEach((cell) => {
    const track = trackOf(cell);
    cell.classList.toggle('is-picked', Boolean(track) && select.has(track));
  });
}

// Capture, so the card's own handlers (open, double click to play) never
// see a press that belongs to the selection
el.rows.addEventListener('click', (event) => {
  if (!select.active()) return;
  const cell = event.target.closest ? event.target.closest('.cell') : null;
  if (!cell) return;
  event.preventDefault();
  event.stopPropagation();
  const track = trackOf(cell);
  if (track) select.toggle(track);
}, true);

select.onChange(markPicked);

/* ---------- Draw ---------- */
function draw(reset) {
  if (reset) shown = PAGE_SIZE;
  const list = visible();
  renderGrid(list, shown, openLightbox, openPicker, playCard, queueCard);
  renderCount(list, state);
  // Fresh cards carry no mark, so it goes back on here
  markPlaying();
  markPicked();
}

function loadMore() {
  if (shown >= visible().length) return;
  shown += PAGE_SIZE;
  draw();
}

/** Named so it can pass itself back to renderChips on every redraw. */
function selectCategory(category) {
  state.category = category;
  renderChips(data, state, selectCategory);
  draw(true);
}

/* ---------- Events ---------- */
el.moreBtn.addEventListener('click', loadMore);

const applyQuery = debounce((value) => {
  state.query = value.trim().toLowerCase();
  draw(true);
}, SEARCH_DELAY);

el.search.addEventListener('input', () => {
  el.searchRow.classList.toggle('has-value', el.search.value.length > 0);
  applyQuery(el.search.value);
});

function clearSearch() {
  el.search.value = '';
  el.searchRow.classList.remove('has-value');
  state.query = '';
  draw(true);
}

el.searchClear.addEventListener('click', () => {
  clearSearch();
  el.search.focus();
});

el.sortSelect.addEventListener('change', () => {
  const [sort, dir] = el.sortSelect.value.split('-');
  state.sort = sort;
  state.dir = dir;
  draw(true);
});

/* Grid or list. Only a class on the grid: the cards are the same, and
   the stylesheet lays them out as rows. Kept as a per-person
   convenience, so a missing store just means it opens as a grid. */
const VIEW_KEY = '999:vault-view';
const viewGrid = document.getElementById('viewGrid');
const viewList = document.getElementById('viewList');

function setView(view) {
  const list = view === 'list';
  el.rows.classList.toggle('is-list', list);
  if (viewGrid) viewGrid.setAttribute('aria-pressed', String(!list));
  if (viewList) viewList.setAttribute('aria-pressed', String(list));
}

let savedView = 'grid';
try { savedView = localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'; } catch { /* no store */ }
setView(savedView);

[[viewGrid, 'grid'], [viewList, 'list']].forEach(([button, view]) => {
  if (!button) return;
  button.addEventListener('click', () => {
    setView(view);
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* not kept */ }
  });
});

/* The picker is opened from a card and from inside the lightbox */
setAddHandler(openPicker);
setPlayHandler(playTrack);

/* The player's random Next picks from whatever the grid is showing,
   not from the whole catalogue. Handing it `visible` rather than the
   list keeps the filter and sort owned here and re-read on every
   pick, so a chip changed mid-track is honoured by the next one. */
setVaultPool(visible);

/* The player says when the loaded track or its state changes; the
   grid follows. Called once on subscribe, so a track resumed from the
   playlists page is marked as soon as the grid draws. */
onPlayback((snap) => {
  now = snap;
  markPlaying();
});

document.addEventListener('keydown', (event) => {
  // The picker is a native <dialog>: it closes itself on Escape and
  // traps Tab on its own. Standing aside is what stops one Escape from
  // also closing the lightbox underneath it.
  if (isPickerOpen()) return;

  if (event.key === 'Escape') {
    if (isOpen()) { closeLightbox(); return; }
    if (document.activeElement === el.search && el.search.value) clearSearch();
    return;
  }

  // "/" jumps to search, unless the user is already typing in a field
  const tag = (document.activeElement.tagName || '').toLowerCase();
  if (event.key === '/' && !['input', 'select', 'textarea'].includes(tag)) {
    event.preventDefault();
    el.search.focus();
    el.search.select();
    return;
  }

  if (event.key === 'Tab' && isOpen()) trapTab(event);
});

/* Pull the next batch in before the reader reaches the bottom */
if ('IntersectionObserver' in window && el.sentinel) {
  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !el.more.hidden) loadMore();
  }, { rootMargin: '600px 0px' }).observe(el.sentinel);
}

/* ---------- Boot ---------- */
async function boot() {
  renderSkeleton();
  setSource('loading', 'Loading the archive');

  let tracks;
  let sourceState;
  let sourceText;

  try {
    const catalogue = await fetchCatalogue();
    tracks = catalogue.tracks;

    if (catalogue.source === 'saved') {
      const when = catalogue.savedAt ? niceDate(catalogue.savedAt.slice(0, 10)) : '';
      sourceState = 'saved';
      sourceText = `Saved copy · ${group(tracks.length)} entries`
        + (when ? ` · ${when}` : '');
    } else {
      sourceState = 'live';
      sourceText = `Live · ${group(tracks.length)} entries`;
    }
  } catch (err) {
    // Offline, or the archive is unreachable: fall back to the bundled sample
    tracks = SEED.map((r) => ({ ...r, a: r.a || [], cov: null }));
    sourceState = 'offline';
    sourceText = `Offline sample · ${err.message || err}`;
  }

  data = tracks;
  buildAssignments(data);

  // Warms the exclusion queue and puts back whatever the last page
  // was playing. Not awaited: it reads IndexedDB and the audio index,
  // and the grid should not wait on either.
  initPlayer();

  setSource(sourceState, sourceText);
  renderChips(data, state, selectCategory);
  draw(true);
  openFromUrl();
}

/**
 * vault.html?rid=<id> opens that record's panel; ?q=<text> runs a
 * search. The shell sends both when the artwork in the bar is pressed,
 * so a track whose id is not in this catalogue still lands on its
 * title. The query is dropped from the URL once read, so a reload of
 * the frame does not open the panel again.
 */
function openFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const rid = params.get('rid');
  const q = params.get('q');
  if (!rid && !q) return;

  try { window.history.replaceState(null, '', window.location.pathname); } catch { /* fine */ }

  const hit = rid ? data.find((t) => t.rid === rid) : null;
  if (hit) {
    openLightbox(hit);
    return;
  }
  if (q) {
    el.search.value = q;
    el.searchRow.classList.add('has-value');
    state.query = q.trim().toLowerCase();
    draw(true);
  }
}

boot();
