/* ============================================================
   Landing page entry point.

   Three jobs:

   1. Render one sample of each generated cover composition, so the
      "eight compositions, not eight colourways" claim on the page is
      shown rather than just stated. This needs no network and runs
      first, so the page is complete before anything is fetched.

   2. Fill the hero mosaic, the drifting strip and the Vault card's
      banner with real artwork from the archive. The page makes a claim
      about a catalogue of cover art, so it should be showing some.

   3. Refresh the figures from the live catalogue, so the numbers here
      come from the same request the Vault uses rather than being typed
      in and left to rot.

   Everything after step 1 is progressive: the markup already carries
   the measured figures and every image box already holds its own
   height, so a slow or failed fetch changes nothing about the layout.
   ============================================================ */

import { fetchCatalogue } from './api.js';
import { SEED } from './seed.js';
import { buildAssignments, buildCover } from './covers.js';
import { renderStrip } from './ui.js';
import { make, group } from './utils.js';

/** Covers in the tilted hero mosaic: three columns of three. */
const MOSAIC_COLS = 3;
const MOSAIC_ROWS = 3;
/** Covers across the top of the Vault card. */
const CARD_TILES = 6;

const elSwatches = document.getElementById('swatches');
const elMosaic = document.getElementById('mosaic');
const elCardArt = document.getElementById('cardArtVault');
const elSource = document.getElementById('source');
const elSourceText = document.getElementById('sourceText');

/* ============================================================
   1. Generated cover samples
   ============================================================ */

/**
 * Eight stubs, so buildAssignments deals each one a different
 * composition. They carry no artwork, so buildCover draws the
 * generated cover and requests no images.
 *
 * Must run before the catalogue is dealt: assignments are module-global
 * in covers.js, so the later buildAssignments(data) call replaces this
 * eight-way deal. The elements built here keep the composition, palette
 * and geometry they were given, so only the ordering matters.
 */
function renderSwatches() {
  if (!elSwatches) return;

  const samples = [
    'Lucid Dreams', 'Righteous', 'Wishing Well', 'Robbery',
    'Empty', 'Conversations', '734', 'Moncler Year'
  ].map((t) => ({ t, a: [], c: 'main', cov: null, art: null }));

  buildAssignments(samples);

  samples.forEach((track) => {
    const wrap = make('div', 'home-swatch');
    wrap.appendChild(buildCover(track, { tag: 'div', eager: true }));
    elSwatches.appendChild(wrap);
  });
}

/* ============================================================
   2. Real artwork
   ============================================================ */

/**
 * Stems and instrumentals reuse a single generic placeholder image
 * across the whole category, so drawing from everything would repeat
 * the same grey cover. `main` is the one category where every entry has
 * its own artwork.
 */
function coverPool(data) {
  const main = data.filter((t) => t.c === 'main' && t.cov);
  return main.length ? main : data.filter((t) => t.cov);
}

/** `n` distinct random tracks, or fewer if the pool is smaller. */
function pick(pool, n) {
  const copy = pool.slice();
  const out = [];
  while (out.length < n && copy.length) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

/**
 * `n` tracks, preferring ones with real artwork and topping up from the
 * rest of the catalogue when there are not enough.
 *
 * The top-up is what keeps these slots full offline: the bundled seed
 * carries artwork on four of its thirty-nine rows, so without it the
 * hero would lose its whole right-hand column the moment the archive is
 * unreachable, which is the dead space this layout exists to remove.
 * The topped-up entries simply draw their generated cover instead.
 */
function fill(pool, data, n) {
  const out = pick(pool, n);
  if (out.length >= n) return out;

  const used = new Set(out.map((t) => t.t));
  return out.concat(pick(data.filter((t) => !used.has(t.t)), n - out.length));
}

/**
 * Fill the tilted hero mosaic.
 *
 * Built column by column rather than as one flat grid, because each
 * column floats on its own timing and that needs a real element to
 * animate.
 */
function renderMosaic(tracks) {
  if (!elMosaic || tracks.length < MOSAIC_COLS * MOSAIC_ROWS) return;

  elMosaic.textContent = '';

  for (let c = 0; c < MOSAIC_COLS; c++) {
    const col = make('div', 'home-mosaic-col');
    for (let r = 0; r < MOSAIC_ROWS; r++) {
      // eager on the first column only: those sit nearest the headline,
      // the rest can arrive as the browser gets to them
      const cell = make('div', 'home-mosaic-cell');
      cell.appendChild(buildCover(tracks[c * MOSAIC_ROWS + r], {
        tag: 'div', eager: c === 0
      }));
      col.appendChild(cell);
    }
    elMosaic.appendChild(col);
  }
}

/** Fill the run of covers across the top of the Vault card. */
function renderCardArt(tracks) {
  if (!elCardArt || !tracks.length) return;

  elCardArt.textContent = '';
  tracks.forEach((track) => {
    const cell = make('div', 'home-card-cell');
    cell.appendChild(buildCover(track, { tag: 'div' }));
    elCardArt.appendChild(cell);
  });
}

/* ============================================================
   3. Figures
   ============================================================ */

function setStat(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

/** Recount from the catalogue, the same way the Vault's hero does. */
function renderStats(data) {
  const categories = new Set();
  let alternates = 0;
  let sessions = 0;

  data.forEach((t) => {
    categories.add(t.c);
    if (t.a.length) alternates++;
    if (t.se) sessions++;
  });

  setStat('statEntries', group(data.length));
  setStat('statAlts', group(alternates));
  setStat('statCats', String(categories.size));
  setStat('statSessions', group(sessions));
}

/** Live / offline indicator under the hero copy. */
function setSource(state, text) {
  if (!elSource) return;
  elSource.dataset.state = state;
  if (elSourceText) elSourceText.textContent = text;
}

/* ============================================================
   Boot
   ============================================================ */

async function start() {
  // First, while the deal is still the eight-stub one
  renderSwatches();

  let data;
  try {
    data = await fetchCatalogue();
    setSource('live', 'Live from the archive');
  } catch (err) {
    // No `cov` on the seed rows, so most of these fall through to a
    // generated cover rather than leaving an empty box.
    data = SEED.map((t) => ({ ...t, cov: null }));
    setSource('offline', 'Offline sample');
  }

  renderStats(data);
  buildAssignments(data);

  const pool = coverPool(data);
  renderMosaic(fill(pool, data, MOSAIC_COLS * MOSAIC_ROWS));
  renderCardArt(fill(pool, data, CARD_TILES));

  // Reuses the Vault's strip, so the double render, the seam-safe tile
  // swapping and the preload timeout all behave identically here.
  renderStrip(data);
}

start();
