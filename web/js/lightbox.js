/* ============================================================
   Detail lightbox.

   Split out from ui.js because it owns something the grid does not:
   focus. It records what opened it, moves focus into the panel, traps
   Tab while open, and puts focus back where it came from on close.
   ============================================================ */

import { make, niceDate, group } from './utils.js';
import { applyCover, markWhenReady } from './covers.js';
import { el, swatchFor } from './ui.js';

/** The element that opened the panel, so focus can be handed back. */
let lastFocus = null;

/** The record currently on show, for the add-to-playlist button. */
let current = null;

/** What that button should call. Registered by app.js, which owns the
    wiring, so this module stays unaware of where a track ends up. */
let onAdd = null;

export function setAddHandler(fn) {
  onAdd = fn;
}

/** The same arrangement for the play button: app.js owns the wiring,
    so this module stays unaware of what plays a track. */
let onPlay = null;

export function setPlayHandler(fn) {
  onPlay = fn;
}

export function isOpen() {
  return !el.lightbox.hidden;
}

export function openLightbox(track, source) {
  lastFocus = source || document.activeElement;
  current = track;

  applyCover(el.lbCover, track);

  const src = track.cov || track.art;
  if (src) {
    el.lbImg.referrerPolicy = 'no-referrer';
    el.lbImg.src = src;
    el.lbImg.hidden = false;
    markWhenReady(el.lbImg);          // set after src, or it never fades in
  } else {
    el.lbImg.hidden = true;
    el.lbImg.removeAttribute('src');
    el.lbImg.classList.remove('is-ready', 'is-failed');
  }

  el.lightbox.style.setProperty('--swatch', swatchFor(track.c));
  el.lbCatName.textContent = track.c;
  el.lbTitle.textContent = track.t;

  // Alternate titles
  el.lbAlts.textContent = '';
  el.lbAlts.hidden = track.a.length === 0;
  el.lbAltsEmpty.hidden = track.a.length !== 0;
  track.a.forEach((name) => el.lbAlts.appendChild(make('li', null, name)));

  // Record
  const pairs = [
    ['Category', track.c],
    ['Duration', track.len || 'Unknown'],
    ['File size', track.sz || 'Unknown'],
    ['Added', niceDate(track.d) || 'Unknown'],
    ['Plays', group(track.p)],
    ['Session edit', track.se ? 'Yes' : 'No']
  ];

  el.lbMeta.textContent = '';
  pairs.forEach(([label, value]) => {
    const row = document.createElement('div');
    row.appendChild(make('dt', null, label));
    row.appendChild(make('dd', null, value));
    el.lbMeta.appendChild(row);
  });

  el.lightbox.hidden = false;
  document.body.style.overflow = 'hidden';
  el.lbClose.focus();
}

export function closeLightbox() {
  if (!isOpen()) return;

  el.lightbox.hidden = true;
  document.body.style.overflow = '';
  current = null;

  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  lastFocus = null;
}

/** Keep Tab inside the panel while it is open. */
export function trapTab(event) {
  const panel = el.lightbox.querySelector('.lb-panel');
  const focusable = panel.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  if (!focusable.length) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/* The panel stays open behind the picker, so the reader lands back on
   the record they were looking at rather than on the grid. */
if (el.lbAdd) {
  el.lbAdd.addEventListener('click', () => {
    if (current && onAdd) onAdd(current, el.lbAdd);
  });
}

/* Play leaves the panel open too. The bar is fixed to the bottom of
   the viewport, so it is visible underneath either way, and closing
   the panel would lose the record the reader was reading. */
if (el.lbPlay) {
  el.lbPlay.addEventListener('click', () => {
    if (current && onPlay) onPlay(current, el.lbPlay);
  });
}

/* Dismiss by clicking the backdrop or the close button */
el.lbClose.addEventListener('click', closeLightbox);
el.lightbox.addEventListener('click', (event) => {
  if (!event.target.closest('.lb-panel')) closeLightbox();
});
