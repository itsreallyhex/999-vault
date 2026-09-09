/* ============================================================
   Rendering.

   Every DOM write the page makes happens in this module or in
   lightbox.js. Nothing here fetches; it is handed data and draws it.
   ============================================================ */

import { CATEGORIES } from './config.js';
import { make, niceDate, group } from './utils.js';
import { buildCover } from './covers.js';

/** Element references, bound once from the ids in index.html. */
export const el = {};

[
  'search', 'searchRow', 'searchClear', 'chips', 'count', 'sortSelect', 'rows',
  'empty', 'heroFigs', 'stripTrack', 'source', 'sourceText', 'more', 'moreBtn',
  'moreCount', 'sentinel', 'lightbox', 'lbClose', 'lbCover', 'lbMark', 'lbImg',
  'lbCat', 'lbCatName', 'lbTitle', 'lbAlts', 'lbAltsEmpty', 'lbMeta'
].forEach((id) => { el[id] = document.getElementById(id); });

/** CSS custom property carrying a category's colour. */
export function swatchFor(category) {
  return CATEGORIES.includes(category) ? `var(--c-${category})` : 'var(--accent)';
}

/** Live / offline / loading indicator in the hero. */
export function setSource(state, text) {
  el.source.dataset.state = state;
  el.sourceText.textContent = text;
}

/* ---------- Hero ---------- */
export function renderHero(data) {
  const categories = new Set();
  let alternates = 0;
  let sessions = 0;

  data.forEach((t) => {
    categories.add(t.c);
    if (t.a.length) alternates++;
    if (t.se) sessions++;
  });

  const figures = [
    ['Entries', group(data.length)],
    ['Categories', categories.size],
    ['Alternate titles', group(alternates)],
    ['Session edits', group(sessions)]
  ];

  el.heroFigs.textContent = '';
  figures.forEach(([label, value]) => {
    const wrap = make('div', 'hero-fig');
    wrap.appendChild(make('dt', 'label', label));
    wrap.appendChild(make('dd', null, value));
    el.heroFigs.appendChild(wrap);
  });

}

/* ---------- Drifting cover strip ---------- */

/** Enough tiles to fill a wide screen; the list is then rendered twice. */
const STRIP_TILES = 16;
const SWAP_INTERVAL = 2200;
/** How long to wait for artwork before swapping anyway. */
const PRELOAD_TIMEOUT = 4000;

let swapTimer = null;
let slotTracks = [];
let stripPool = [];

function sample(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Stems and instrumentals reuse a single generic placeholder image across
 * the whole category, so pulling from everything makes the strip repeat the
 * same grey cover. Draw from `main`, which has real per-track artwork.
 */
function coverPool(data) {
  const main = data.filter((t) => t.c === 'main' && t.cov);
  if (main.length) return main;
  const withArt = data.filter((t) => t.cov || t.art);
  return withArt.length ? withArt : data;
}

/**
 * Warm an image into the browser cache and wait until it can paint.
 * Resolves either way: a failed load just means the generated cover
 * stays visible, which is the intended fallback.
 */
function preload(src, timeout = PRELOAD_TIMEOUT) {
  if (!src) return Promise.resolve(false);

  // createElement rather than `new Image()`: same result, one less global
  const img = document.createElement('img');
  img.referrerPolicy = 'no-referrer';
  img.src = src;

  // decode() resolves only when the frame is ready to paint, which a plain
  // load event does not guarantee
  const ready = typeof img.decode === 'function'
    ? img.decode().then(() => true, () => false)
    : new Promise((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
    });

  // An image that neither loads nor errors would leave the swap lock held
  // and stop the strip rotating for good, so give up waiting and continue.
  return Promise.race([
    ready,
    new Promise((resolve) => setTimeout(() => resolve(false), timeout))
  ]);
}

let swapping = false;

/** Crossfade one random tile to a different random track. */
async function swapTile() {
  if (swapping) return;                            // no overlapping swaps
  const slot = Math.floor(Math.random() * slotTracks.length);
  const next = sample(stripPool);
  if (next.t === slotTracks[slot].t) return;       // skip a no-op swap

  swapping = true;
  try {
    // Load the artwork first. Building the tile before the image is ready
    // is what made the generated cover flash for a frame.
    await preload(next.cov || next.art);

    slotTracks[slot] = next;

    // Both copies of the slot change together, or the loop seam would show
    const tiles = el.stripTrack.querySelectorAll(`.strip-tile[data-slot="${slot}"]`);
    tiles.forEach((tile) => tile.classList.add('is-swapping'));

    await new Promise((resolve) => setTimeout(resolve, 320));

    tiles.forEach((tile) => {
      tile.textContent = '';
      // eager: the file is cached now, so it paints on the first frame
      tile.appendChild(buildCover(next, { tag: 'div', eager: true }));
      tile.classList.remove('is-swapping');
    });
  } finally {
    swapping = false;
  }
}

export function renderStrip(data) {
  if (!el.stripTrack) return;

  clearInterval(swapTimer);
  swapTimer = null;
  el.stripTrack.textContent = '';
  if (!data.length) return;

  stripPool = coverPool(data);

  slotTracks = Array.from(
    { length: Math.min(STRIP_TILES, stripPool.length) },
    () => sample(stripPool)
  );

  // Rendered twice so the -50% keyframe lands on an identical copy
  for (let pass = 0; pass < 2; pass++) {
    slotTracks.forEach((track, slot) => {
      const tile = make('div', 'strip-tile');
      tile.dataset.slot = String(slot);
      tile.appendChild(buildCover(track, { tag: 'div', eager: pass === 0 && slot < 6 }));
      el.stripTrack.appendChild(tile);
    });
  }

  // The CSS already stops the drift and the crossfade under reduced motion;
  // this just avoids running the swap timer pointlessly. Guarded because a
  // missing matchMedia would otherwise take the whole boot down with it.
  const still = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still || stripPool.length <= 1) return;

  swapTimer = setInterval(swapTile, SWAP_INTERVAL);
}

/* ---------- Filter chips ---------- */
export function renderChips(data, state, onSelect) {
  const counts = {};
  data.forEach((t) => { counts[t.c] = (counts[t.c] || 0) + 1; });

  const items = [{ key: 'all', name: 'All', n: data.length }].concat(
    CATEGORIES.filter((c) => counts[c])
      .map((c) => ({ key: c, name: c, n: counts[c] }))
  );

  el.chips.textContent = '';
  items.forEach((item) => {
    const btn = make('button', 'chip');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(state.category === item.key));
    btn.style.setProperty('--swatch', swatchFor(item.key));

    btn.appendChild(make('span', 'dot'));
    btn.appendChild(document.createTextNode(item.name));
    btn.appendChild(make('span', 'n', group(item.n)));

    btn.addEventListener('click', () => onSelect(item.key));
    el.chips.appendChild(btn);
  });
}

/* ---------- Cards ---------- */
function buildCard(track, onOpen) {
  const li = document.createElement('li');

  const btn = make('button', 'card');
  btn.type = 'button';
  btn.style.setProperty('--swatch', swatchFor(track.c));
  btn.setAttribute(
    'aria-label',
    `${track.t}, ${track.c}${track.len ? `, ${track.len}` : ''}`
  );

  const shot = make('span', 'card-shot');
  shot.appendChild(buildCover(track));

  const badge = make('span', 'card-badge');
  badge.appendChild(make('span', 'dot'));
  badge.appendChild(document.createTextNode(track.c));
  shot.appendChild(badge);

  if (track.len) shot.appendChild(make('span', 'card-len', track.len));

  // Hover overlay carries the detail the card has no room for
  const veil = make('span', 'shot-veil');
  const text = make('span', 'veil-text');
  if (track.a.length) {
    text.appendChild(make('span', 'k', 'also known as'));
    text.appendChild(document.createTextNode(track.a.join(' · ')));
  } else {
    text.appendChild(make('span', 'k', 'added'));
    text.appendChild(document.createTextNode(niceDate(track.d)));
  }
  veil.appendChild(text);
  shot.appendChild(veil);
  btn.appendChild(shot);

  const body = make('span', 'card-body');
  body.appendChild(make('span', 'card-title', track.t));
  body.appendChild(make('span', 'card-sub',
    track.se ? `Session edit · ${track.sz}` : track.sz));
  btn.appendChild(body);

  btn.addEventListener('click', () => onOpen(track, btn));

  li.appendChild(btn);
  return li;
}

/** Shimmer placeholders while the catalogue is in flight. */
export function renderSkeleton() {
  el.rows.textContent = '';
  for (let i = 0; i < 18; i++) {
    const li = make('li', 'skeleton');
    li.appendChild(make('span', 'card-shot'));
    li.appendChild(make('span', 'sk-line'));
    li.appendChild(make('span', 'sk-line short'));
    el.rows.appendChild(li);
  }
}

/**
 * Draw the grid.
 * `list` is the full filtered set; only the first `shown` are built,
 * so the DOM never holds thousands of cards at once.
 */
export function renderGrid(list, shown, onOpen) {
  const batch = list.slice(0, shown);

  const frag = document.createDocumentFragment();
  batch.forEach((track) => frag.appendChild(buildCard(track, onOpen)));

  el.rows.textContent = '';
  el.rows.appendChild(frag);

  el.empty.hidden = list.length !== 0;

  const remaining = list.length - batch.length;
  el.more.hidden = remaining <= 0;
  if (remaining > 0) {
    el.moreCount.textContent = `${group(batch.length)} of ${group(list.length)} shown`;
  }
}

/** "3,879 entries in cut matching …" */
export function renderCount(list, state) {
  let tail = ` ${list.length === 1 ? 'entry' : 'entries'}`;
  if (state.category !== 'all') tail += ` in ${state.category}`;
  if (state.query) tail += ` matching "${state.query}"`;

  el.count.textContent = '';
  el.count.appendChild(make('b', null, group(list.length)));
  el.count.appendChild(document.createTextNode(tail));
}
