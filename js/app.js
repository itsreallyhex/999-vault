/* ============================================================
   Entry point.

   Owns the view state, the filter/sort pipeline, pagination and all
   event wiring, then hands the results to ui.js to draw. The only
   module index.html loads directly.
   ============================================================ */

import { PAGE_SIZE, SEARCH_DELAY } from './config.js';
import { seconds, bytes, group, debounce } from './utils.js';
import { fetchCatalogue } from './api.js';
import { buildAssignments } from './covers.js';
import {
  el, setSource, renderHero, renderStrip, renderChips,
  renderSkeleton, renderGrid, renderCount
} from './ui.js';
import { openLightbox, closeLightbox, isOpen, trapTab, setAddHandler } from './lightbox.js';
import { openPicker, isPickerOpen } from './picker.js';
import { SEED } from './seed.js';

/* ---------- State ---------- */
let data = [];
let shown = PAGE_SIZE;

const state = { query: '', category: 'all', sort: 'plays', dir: 'desc' };

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

/* ---------- Draw ---------- */
function draw(reset) {
  if (reset) shown = PAGE_SIZE;
  const list = visible();
  renderGrid(list, shown, openLightbox, openPicker);
  renderCount(list, state);
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

/* The picker is opened from a card and from inside the lightbox */
setAddHandler(openPicker);

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
    tracks = await fetchCatalogue();
    sourceState = 'live';
    sourceText = `Live · ${group(tracks.length)} entries`;
  } catch (err) {
    // Offline, or the archive is unreachable: fall back to the bundled sample
    tracks = SEED.map((r) => ({ ...r, a: r.a || [], cov: null }));
    sourceState = 'offline';
    sourceText = `Offline sample · ${err.message || err}`;
  }

  data = tracks;
  buildAssignments(data);
  setSource(sourceState, sourceText);
  renderHero(data);
  renderStrip(data);
  renderChips(data, state, selectCategory);
  draw(true);
}

boot();
