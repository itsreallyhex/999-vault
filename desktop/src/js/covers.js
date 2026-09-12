/* ============================================================
   Cover art.

   Real artwork from the archive is used wherever it loads. When it
   does not, a cover is generated from the title so a card is never
   blank. The generated art is not a recoloured template: there are
   eight distinct compositions in style.css and this module decides
   which one a title gets, plus its palette, angle and focal point.
   ============================================================ */

import { PALETTES, COMPOSITIONS } from './config.js';
import { hash, make } from './utils.js';
import { coverUrl } from './api.js';

/** title -> { art, pal }. Rebuilt whenever the dataset changes. */
let assignments = {};

/**
 * Deal compositions across the catalogue.
 *
 * Picking with `hash % n` clumps badly on small sets: over 39 rows it
 * put one composition on ten of them and left six tracks sharing both
 * a composition and a palette. Dealing round-robin over a hash-ordered
 * list spreads them evenly instead. Order still comes from the title,
 * so a track keeps its cover regardless of the current sort or filter.
 */
export function buildAssignments(data) {
  assignments = {};
  data.slice()
    .sort((a, b) => hash(a.t) - hash(b.t))
    .forEach((track, i) => {
      const art = i % COMPOSITIONS;
      const cycle = Math.floor(i / COMPOSITIONS);
      assignments[track.t] = { art, pal: (art * 2 + cycle) % PALETTES.length };
    });
}

/**
 * The mark printed on a generated cover.
 * It varies by composition, so the same title does not always resolve
 * to the same two letters.
 */
function markFor(title, art) {
  const words = title.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '999';

  const first = words[0];
  const initials = words.slice(0, 2).map((w) => w.charAt(0)).join('').toUpperCase();
  const version = /\(v([\d.]+)\)/i.exec(title);
  const leadNum = /^\d[\d.]*$/.test(first) ? first.slice(0, 4) : null;

  if (art === 5) return first.toUpperCase().slice(0, 8);         // Type: the word is the art
  if (art === 2) return version ? `V${version[1]}` : initials;    // Columns: version tag
  if (art === 6) return leadNum || first.toUpperCase().slice(0, 6);
  return leadNum || initials;
}

/** Everything needed to paint one generated cover. */
export function coverSpec(title) {
  const fixed = assignments[title] || {
    art: hash(title) % COMPOSITIONS,
    pal: hash(title) % PALETTES.length
  };
  // Salted so geometry varies independently of palette and composition
  const geo = hash(`${title}~geo`);

  return {
    art: fixed.art,
    pal: PALETTES[fixed.pal],
    ang: 15 + (geo % 15) * 23,
    fx: 16 + (geo >>> 5) % 68,
    fy: 16 + (geo >>> 13) % 68,
    mark: markFor(title, fixed.art)
  };
}

/**
 * Drive an image's fade-in.
 *
 * `.cover-img` starts at opacity 0 so the generated cover underneath shows
 * until the real artwork has decoded. Something must therefore add
 * `is-ready`, or the image stays invisible forever. Uses onload/onerror
 * properties rather than listeners because the lightbox reuses one <img>
 * across every open, and listeners would stack up on it.
 *
 * Call this after setting `src`.
 */
export function markWhenReady(img) {
  img.classList.remove('is-ready', 'is-failed');
  img.onload = () => img.classList.add('is-ready');
  img.onerror = () => img.classList.add('is-failed');
  // A cached image can already be complete by the time we get here
  if (img.complete && img.naturalWidth) img.classList.add('is-ready');
}

/** Paint an existing .cover element for a track. */
export function applyCover(cover, track) {
  const s = coverSpec(track.t);

  cover.style.setProperty('--c1', s.pal[0]);
  cover.style.setProperty('--c2', s.pal[1]);
  cover.style.setProperty('--c3', s.pal[2]);
  cover.style.setProperty('--ang', `${s.ang}deg`);
  cover.style.setProperty('--fx', `${s.fx}%`);
  cover.style.setProperty('--fy', `${s.fy}%`);
  cover.dataset.art = String(s.art);

  const mark = cover.querySelector('.cover-mark');
  if (mark) mark.textContent = s.mark;
}

/**
 * Build a .cover element, with the archive's artwork layered over the
 * generated one. If the image fails, it hides itself and the generated
 * cover underneath shows through.
 */
/**
 * The URL to actually load for a track's artwork, or null.
 *
 * `cov` is a path, not a URL: `data/covers/<sha1>.webp` from a saved
 * snapshot, or `/cdn/...` from the live listing. Both are portable and
 * both are what gets written into a playlist row. Turning one into
 * something this window can load is a rendering concern and happens
 * here, once, at the moment a cover is drawn.
 *
 * Null when the archive folder is not there, which leaves the generated
 * cover underneath showing through: the same thing the site does when a
 * cover fails to load.
 */
export function coverSrc(track) {
  if (!track) return null;
  return coverUrl(track.cov) || track.art || null;
}

export function buildCover(track, { tag = 'span', eager = false } = {}) {
  const cover = make(tag, 'cover');
  cover.appendChild(make('span', 'cover-mark'));
  applyCover(cover, track);

  const src = coverSrc(track);
  if (src) {
    const img = document.createElement('img');
    img.className = 'cover-img';
    img.src = src;
    img.alt = '';                       // decorative: the title sits beside it
    img.loading = eager ? 'eager' : 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    markWhenReady(img);
    cover.appendChild(img);
  }

  return cover;
}
