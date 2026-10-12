/* ============================================================
   The idle screen.

   After a while with no input, while a track is playing, the whole
   window is covered by the track's cover, large and sharp in the
   middle, over the same cover blurred to fill the window. When the
   track changes the old cover fades out and the new one fades in.
   It stays until the X is pressed (or Escape): moving the mouse or
   touching a key does not put the app back. The player's shortcuts
   (Space, the arrows) are js/hotkeys.js, which works with this screen
   up or down; this only shows what they did, and holds Tab.

   shell.js only. It lives in the shell's document because that is
   the one that owns the bar and the audio; the frame's pages never
   know it exists. The frame is a separate document, so its input
   never reaches the shell's listeners: initAmbient() listens on the
   frame's window as well, and again after every frame load. That
   input only matters while the screen is down, to keep the idle
   clock honest.

   Two slots, not one. Each slot is a full layer holding a blurred
   cover and the sharp cover with its title. A track change fills the
   hidden slot, waits for its image, then crossfades. The blurred
   layer fades in UNDER the old one, which stays at full opacity
   until the new one has covered it: two layers each at half opacity
   would let the dark page through and dip the whole window.
   ============================================================ */

import { make, clock } from './utils.js';
import { buildCover, coverSpec, coverSrc, markWhenReady } from './covers.js';
import { anyDialogOpen } from './hotkeys.js';
import { fetchLyrics, fetchOtherVersion, activeIndex, trackKey } from './lyrics.js';

/** What the lyrics line says when there are none to show. "offline" is
    only for a request that got no answer at all; a server that answered
    with an error is "busy", and the screen says which. */
const LYRICS_NOTE = {
  none: 'No lyrics found',
  off: 'Lyrics lookup is off. Add a .lrc file, or turn it on in Settings.',
  offline: 'Could not reach LRCLIB. Check the connection and try again.',
  busy: 'LRCLIB is busy right now. Try again in a moment.',
  instrumental: 'Instrumental',
  skip: ''
};

/** What the line says when asking for another version gave none. */
const OTHER_NOTE = {
  only_version: 'LRCLIB has only this version of the lyrics',
  offline: 'Could not reach LRCLIB for another version',
  busy: 'LRCLIB is busy, so no other version yet',
  off: 'The lyrics lookup is off, so no other version'
};

/** How long with no input before the screen comes up. */
const IDLE_MS = 30000;
/** The background crossfade. Keep in step with --amb-fade in ambient.css. */
const FADE_MS = 1400;
/** Longest the swap waits for the incoming cover before going anyway. */
const IMAGE_WAIT = 1500;

const INPUTS = ['mousemove', 'mousedown', 'wheel', 'keydown', 'keyup', 'touchstart', 'pointerdown'];
/** How long the one-line "Volume 65%" / "Paused" readout stays. */
const NOTE_MS = 1300;
const NS = 'http://www.w3.org/2000/svg';

function makeSlot() {
  const el = make('div', 'amb-slot');

  const img = make('img', 'amb-bg');
  img.alt = '';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  el.appendChild(img);

  const front = make('div', 'amb-front');
  const art = make('div', 'amb-art');
  const text = make('div', 'amb-text');
  const title = make('p', 'amb-title');
  const sub = make('p', 'amb-sub');
  // Lyrics, when there are any. Hidden until an answer has arrived.
  const lyr = make('div', 'amb-lyr');
  lyr.hidden = true;
  const src = make('p', 'amb-src');
  // Shown only beside "No lyrics found" and "unavailable": asks again,
  // past a kept miss. The one way to get a second opinion on a miss.
  const retry = make('button', 'amb-retry', 'Try again');
  retry.type = 'button';
  retry.hidden = true;
  // Shown beside lyrics from LRCLIB: LRCLIB often holds several different
  // texts under one name, and only the person knows which is the song.
  const other = make('button', 'amb-retry amb-other', 'Wrong lyrics? Try another version');
  other.type = 'button';
  other.hidden = true;
  // Timed lyrics can be scrolled by hand, and this puts them back on the
  // line the song is at. Over the window's corner, so it takes no room.
  const back = make('button', 'amb-back', 'Back to current line');
  back.type = 'button';
  back.hidden = true;
  const lyrBox = make('div', 'amb-lyrbox');
  lyrBox.append(lyr, back);
  text.append(title, sub, lyrBox, src, retry, other);
  front.append(art, text);
  el.appendChild(front);

  return {
    el, img, art, title, sub, lyr, back, src, retry, other,
    free: false,     // the lyrics were scrolled by hand and do not follow
    track: null,     // what the slot holds
    asked: null,     // the key lyrics were last asked for
    lines: null,     // timed lyrics: [{ at, text }]
    items: [],       // their <li>s
    list: null,      // the <ol>
    idx: -2          // the line shown as current; -2 is "not painted yet"
  };
}

/** Put an answer in a slot: timed lines, plain text, or a one-line note.
    `again` is set when this answer is to a "Try again", so a repeat miss
    says it is a repeat rather than looking like nothing happened. */
function paintLyrics(slot, result, again = false) {
  slot.lyr.textContent = '';
  slot.lines = null;
  slot.items = [];
  slot.list = null;
  slot.idx = -2;
  slot.free = false;
  slot.back.hidden = true;
  slot.lyr.classList.remove('is-plain', 'is-timed');
  // A second try only makes sense where a second look could differ
  slot.retry.hidden = !(result.state === 'none' || result.state === 'offline' || result.state === 'busy');
  slot.retry.disabled = false;
  slot.retry.textContent = 'Try again';
  // Another version: only for text that came from LRCLIB, and not once
  // Rust has said there is just the one
  slot.other.hidden = true;
  slot.other.disabled = false;
  slot.other.textContent = 'Wrong lyrics? Try another version';

  if (result.state === 'found') {
    if (result.lines) {
      // Pressing a line jumps the song to it; initAmbient() listens.
      const list = make('ol', 'amb-lines is-seekable');
      slot.items = result.lines.map((l) => {
        const li = make('li', 'amb-lyric', l.text || '♪');
        li.title = 'Jump to this line';
        list.appendChild(li);
        return li;
      });
      slot.lyr.classList.add('is-timed');
      slot.lyr.appendChild(list);
      slot.list = list;
      slot.lines = result.lines;
    } else {
      const box = make('div', 'amb-plain');
      result.plain.forEach((line) => box.appendChild(make('p', line ? '' : 'amb-gap', line)));
      slot.lyr.classList.add('is-plain');
      slot.lyr.appendChild(box);
    }
    slot.lyr.hidden = false;

    if (result.source === 'file') {
      slot.src.textContent = 'Lyrics from a file on this machine';
      return;
    }

    // Which of the texts this is, once there is more than one
    let line = 'Lyrics from LRCLIB';
    if (result.versions > 1 && result.version) line += `, version ${result.version} of ${result.versions}`;
    // Why asking for another one gave none, kept beside the words
    if (result.notice && OTHER_NOTE[result.notice]) line = `${OTHER_NOTE[result.notice]}`;
    slot.src.textContent = line;

    const one = result.versions === 1 || result.notice === 'only_version';
    slot.other.hidden = one;
    return;
  }

  slot.lyr.hidden = true;
  const detail = result.detail ? ` (${result.detail})` : '';
  if (again && result.state === 'none') slot.src.textContent = 'Asked again, still no lyrics found';
  else if (again && result.state === 'offline') slot.src.textContent = `Asked again, still could not reach LRCLIB${detail}`;
  else if (again && result.state === 'busy') slot.src.textContent = `Asked again, LRCLIB is still busy${detail}`;
  else if (result.state === 'offline' || result.state === 'busy') slot.src.textContent = `${LYRICS_NOTE[result.state]}${detail}`;
  else slot.src.textContent = LYRICS_NOTE[result.state] || '';
}

/** Scroll the window so the current line is in the middle. */
function centerLine(slot, smooth) {
  const cur = slot.items[slot.idx];
  const top = cur ? Math.max(0, cur.offsetTop + cur.offsetHeight / 2 - slot.lyr.clientHeight / 2) : 0;
  const still = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof slot.lyr.scrollTo === 'function') {
    slot.lyr.scrollTo({ top, behavior: smooth && !still ? 'smooth' : 'auto' });
  } else {
    slot.lyr.scrollTop = top;
  }
}

/** Let go of the song's line (the person scrolled) or take it back
    (the button, a pressed line, a drag of the progress line). */
function setFree(slot, free) {
  slot.free = free;
  slot.back.hidden = !free;
  if (!free && slot.list) centerLine(slot, true);
}

/** Mark the line that is current at `sec`, and bring it to the middle
    unless the lyrics were scrolled away by hand. */
function syncLyrics(slot, sec) {
  if (!slot.lines || !slot.list) return;
  const idx = activeIndex(slot.lines, sec);
  if (idx === slot.idx) return;
  // The first line painted after the words arrive is put in place at
  // once, not scrolled to from the top
  const first = slot.idx === -2;
  slot.idx = idx;

  slot.items.forEach((li, i) => {
    li.classList.toggle('is-now', i === idx);
    li.classList.toggle('is-past', i < idx);
  });

  if (!slot.free) centerLine(slot, !first);
}

/** The slot painted for a track: blurred image, sharp cover, words. The
    palette goes on the slot so a track with no real artwork still gets
    a wash of its own colours behind the generated cover. */
function fillSlot(slot, track) {
  const spec = coverSpec(track.t);
  slot.el.style.setProperty('--c1', spec.pal[0]);
  slot.el.style.setProperty('--c2', spec.pal[1]);
  slot.el.style.setProperty('--c3', spec.pal[2]);

  const src = coverSrc(track);
  if (src) {
    slot.img.src = src;
    markWhenReady(slot.img);
  } else {
    slot.img.removeAttribute('src');
    slot.img.classList.remove('is-ready');
  }

  slot.art.textContent = '';
  slot.art.appendChild(buildCover(track, { eager: true }));
  slot.title.textContent = track.t;
  slot.sub.textContent = track.c || '';

  // A slot is reused, so what it said about the last song goes
  slot.track = track;
  slot.asked = null;
  slot.lines = null;
  slot.items = [];
  slot.list = null;
  slot.idx = -2;
  slot.free = false;
  slot.back.hidden = true;
  slot.lyr.textContent = '';
  slot.lyr.hidden = true;
  slot.src.textContent = '';
  slot.retry.hidden = true;
  slot.other.hidden = true;
}

/** Resolves once the slot's image has loaded or failed, or at once when
    there is no image to wait for. */
function imageSettled(img) {
  if (!img.getAttribute('src') || (img.complete && img.naturalWidth)) return Promise.resolve();
  return new Promise((done) => {
    img.addEventListener('load', () => done(), { once: true });
    img.addEventListener('error', () => done(), { once: true });
  });
}

/** The X: the same cross the bar's own close button draws. */
function crossIcon() {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M6 6l12 12M18 6L6 18');
  svg.appendChild(path);
  return svg;
}

/**
 * Start the idle screen.
 *
 *   player  the shell's player module (onPlayback, sameTrack, timing)
 *   frame   the iframe the pages are shown in
 *
 * Returns { show, hide, isOn, note }. show and hide let a check drive
 * it without waiting thirty seconds; note(text) is the readout the
 * shortcuts report to.
 */
export function initAmbient({ player, frame }) {
  const root = make('div', 'amb');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Now playing');

  const slots = [makeSlot(), makeSlot()];
  slots[0].el.classList.add('is-active', 'is-lit');
  const veil = make('span', 'amb-veil');

  const prog = make('div', 'amb-prog');
  const elapsed = make('span', 'amb-time mono', '0:00');
  const line = make('span', 'amb-line');
  const lineFill = make('i');
  line.appendChild(lineFill);
  const total = make('span', 'amb-time mono', '0:00');
  prog.append(elapsed, line, total);

  const close = make('button', 'amb-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close the now playing screen');
  close.appendChild(crossIcon());

  // The bar is under the screen, so a key that changes something the
  // screen does not show (the volume, play or pause) says what it did.
  const noteEl = make('p', 'amb-note');
  noteEl.setAttribute('role', 'status');
  noteEl.setAttribute('aria-live', 'polite');

  // The slots take a rising z-index so the newest sits on top. Held in
  // their own stacking context so that counter can never climb past the
  // veil, the progress line and the X, which stay above them.
  const stack = make('div', 'amb-slots');
  stack.append(slots[0].el, slots[1].el);

  root.append(stack, veil, prog, noteEl, close);
  document.body.appendChild(root);

  let front = 0;            // index of the slot on show
  let z = 1;                // stacking counter, so the newest slot is on top
  let on = false;
  let playing = false;
  let shownTrack = null;
  let swapToken = 0;
  let lastInput = Date.now();
  let returnTo = null;      // what had focus when it came up
  let progTimer = null;
  let noteTimer = null;

  function note(text) {
    noteEl.textContent = text;
    noteEl.classList.add('is-shown');
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => noteEl.classList.remove('is-shown'), NOTE_MS);
  }

  /* ---------- Content ---------- */

  function swapTo(incoming) {
    const outgoing = slots[front];
    incoming.el.style.zIndex = String(++z);
    // Flush the hidden state first: the swap can land in the same frame
    // as the fill when the image was already cached, and a transition
    // needs a computed starting value to run from.
    void incoming.el.offsetWidth;
    incoming.el.classList.add('is-active', 'is-lit');
    outgoing.el.classList.remove('is-lit');
    front = slots.indexOf(incoming);
    setTimeout(() => {
      if (outgoing !== slots[front]) outgoing.el.classList.remove('is-active');
    }, FADE_MS + 100);
  }

  function setTrack(track) {
    if (!track) { shownTrack = null; return; }
    if (shownTrack && player.sameTrack(shownTrack, track)) return;
    shownTrack = track;
    const token = ++swapToken;

    if (!on) {
      // Out of sight: no fade to make, just have it ready for later
      fillSlot(slots[front], track);
      return;
    }

    const incoming = slots[1 - front];
    fillSlot(incoming, track);
    wantLyrics(incoming);
    const wait = new Promise((done) => setTimeout(done, IMAGE_WAIT));
    Promise.race([imageSettled(incoming.img), wait]).then(() => {
      if (token === swapToken) swapTo(incoming);
    });
  }

  /**
   * Ask for this slot's lyrics, once. Called only with the screen up and
   * the slot's song on it: that is the one place anything is asked, so a
   * song nobody is looking at is never looked up. See lyrics.rs for what
   * a request carries.
   */
  function wantLyrics(slot) {
    const track = slot.track;
    if (!track) return;
    const key = trackKey(track);
    if (slot.asked === key) return;
    slot.asked = key;

    fetchLyrics(track).then((result) => {
      // The slot may have been refilled for another song while this ran
      if (slot.track && trackKey(slot.track) === key) paintLyrics(slot, result);
    });
  }

  /** "Try again": ask once more, past a kept miss and a remembered
      failure. The slot says so while it waits. */
  function retryLyrics(slot) {
    const track = slot.track;
    if (!track) return;
    const key = trackKey(track);
    // Stays on screen, greyed, with the work said out loud: a button
    // that vanishes, or one that looks untouched, reads as "nothing
    // happened" on a request that takes a second or two
    slot.retry.disabled = true;
    slot.retry.textContent = 'Looking again';
    slot.src.textContent = 'Asking again';
    fetchLyrics(track, { force: true }).then((result) => {
      if (slot.track && trackKey(slot.track) === key) paintLyrics(slot, result, true);
    });
  }
  slots.forEach((slot) => slot.retry.addEventListener('click', () => retryLyrics(slot)));

  /** "Wrong lyrics? Try another version": the next of the texts LRCLIB
      holds under this name, kept for the song. The words are swapped in
      place when they arrive. */
  function otherVersion(slot) {
    const track = slot.track;
    if (!track) return;
    const key = trackKey(track);
    slot.other.disabled = true;
    slot.other.textContent = 'Looking for another version';
    fetchOtherVersion(track).then((result) => {
      if (!slot.track || trackKey(slot.track) !== key) return;
      if (result.state === 'found') {
        paintLyrics(slot, result);
        return;
      }
      // Could not turn the page: leave the words, say why
      slot.other.disabled = false;
      slot.other.textContent = 'Wrong lyrics? Try another version';
      slot.src.textContent = OTHER_NOTE[result.state] || 'Could not look for another version';
    });
  }
  slots.forEach((slot) => slot.other.addEventListener('click', () => otherVersion(slot)));

  /** A press on a timed line: seek there, and move the highlight now
      rather than at the next half-second tick. Plain lyrics have no
      times, so they have no lines to press. Only the slot on show
      answers; the other is behind it and takes no pointer. */
  slots.forEach((slot) => slot.lyr.addEventListener('click', (event) => {
    const li = event.target && event.target.closest ? event.target.closest('.amb-lyric') : null;
    if (!li || !slot.lines || slot !== slots[front]) return;
    const i = slot.items.indexOf(li);
    if (i < 0) return;
    const to = player.seekTo(slot.lines[i].at);
    if (to === null) return;
    setFree(slot, false);
    syncLyrics(slot, to);
    paintProgress();
  }));

  /* Scrolling the lyrics by hand lets go of the song's line until the
     button is pressed, a line is pressed, or the progress line is
     dragged. Only the wheel and touch count: the scroll that follows the
     song fires neither. */
  slots.forEach((slot) => {
    const grab = () => {
      if (slot.lines && slot === slots[front] && !slot.free) setFree(slot, true);
    };
    slot.lyr.addEventListener('wheel', grab, { passive: true });
    slot.lyr.addEventListener('touchmove', grab, { passive: true });
    slot.back.addEventListener('click', () => setFree(slot, false));
  });

  /* Dragging the progress line. The words follow the handle while it is
     held; the song itself is moved once, on release, so a stream is not
     asked for a new range at every pixel. */
  let dragging = false;

  function dragSecond(event) {
    const t = player.timing();
    if (!(t.total > 0)) return null;
    const box = line.getBoundingClientRect();
    if (!(box.width > 0)) return null;
    const frac = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    return { sec: frac * t.total, total: t.total };
  }

  function paintDrag(event) {
    const at = dragSecond(event);
    if (!at) return null;
    elapsed.textContent = clock(at.sec);
    lineFill.style.width = `${(at.sec / at.total) * 100}%`;
    syncLyrics(slots[front], at.sec);
    return at.sec;
  }

  function endDrag(event, commit) {
    if (!dragging) return;
    const at = commit ? dragSecond(event) : null;
    dragging = false;
    line.classList.remove('is-drag');
    try { line.releasePointerCapture(event.pointerId); } catch { /* not held */ }
    if (at) player.seekTo(at.sec);
    paintProgress();
  }

  line.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !(player.timing().total > 0)) return;
    event.preventDefault();
    dragging = true;
    line.classList.add('is-drag');
    try { line.setPointerCapture(event.pointerId); } catch { /* no capture */ }
    // The words follow the handle, even if they were scrolled away
    setFree(slots[front], false);
    paintDrag(event);
  });
  line.addEventListener('pointermove', (event) => { if (dragging) paintDrag(event); });
  line.addEventListener('pointerup', (event) => endDrag(event, true));
  line.addEventListener('pointercancel', (event) => endDrag(event, false));

  function paintProgress() {
    // The handle is held: the half-second tick must not pull it back
    if (dragging) return;
    const t = player.timing();
    elapsed.textContent = clock(t.at);
    total.textContent = t.total > 0 ? clock(t.total) : (shownTrack && shownTrack.len) || '0:00';
    const pct = t.total > 0 ? Math.min(100, (t.at / t.total) * 100) : 0;
    lineFill.style.width = `${pct}%`;
    syncLyrics(slots[front], t.at);
  }

  /* ---------- Up next, on the screen ----------
     The same lists the Up next sheet draws, as a glass panel at the
     right: what was queued, then what follows on its own. A press on a
     song plays it. The cross puts the panel away and a small "Up next"
     button brings it back; the choice is kept, as a per-person
     convenience. Nothing is drawn when nothing is coming. */
  const QUEUE_KEY = '999:amb-queue';
  const THEN_LABEL = {
    playlist: 'Next in this playlist',
    vault: 'Next, picked at random from the Vault',
    'repeat-one': 'Repeat is on, so this plays again'
  };
  const QUEUE_ROWS = 8;
  let queueOn = true;
  try { queueOn = localStorage.getItem(QUEUE_KEY) !== 'off'; } catch { /* no storage */ }
  let upNext = { queue: [], then: { kind: 'none', tracks: [], more: 0 } };

  const queueBox = make('aside', 'amb-queue');
  queueBox.setAttribute('aria-label', 'Up next');
  queueBox.hidden = true;
  const queueHead = make('div', 'amb-queue-head');
  const queueCount = make('span', 'amb-queue-count mono', '');
  const queueX = make('button', 'amb-queue-x');
  queueX.type = 'button';
  queueX.setAttribute('aria-label', 'Hide up next');
  queueX.appendChild(crossIcon());
  queueHead.append(make('h2', 'amb-queue-title', 'Up next'), queueCount, queueX);
  const queueBody = make('div', 'amb-queue-body');
  queueBox.append(queueHead, queueBody);

  const queuePill = make('button', 'amb-queue-pill', 'Up next');
  queuePill.type = 'button';
  queuePill.hidden = true;
  root.append(queueBox, queuePill);

  function queueRow(track, onPlay) {
    const go = make('button', 'amb-q-go');
    go.type = 'button';
    go.setAttribute('aria-label', `Play ${track.t}`);
    const shot = make('span', 'amb-q-shot');
    shot.appendChild(buildCover(track));
    const text = make('span', 'amb-q-text');
    text.appendChild(make('span', 'amb-q-title', track.t));
    const meta = [track.c, track.len].filter(Boolean).join('  ·  ');
    if (meta) text.appendChild(make('span', 'amb-q-meta mono', meta));
    go.append(shot, text);
    go.addEventListener('click', onPlay);
    return go;
  }

  function paintQueue() {
    const entries = upNext.queue || [];
    const then = upNext.then || { kind: 'none', tracks: [], more: 0 };
    const has = entries.length + then.tracks.length > 0;

    queueBody.textContent = '';
    if (has) {
      const frag = document.createDocumentFragment();
      if (entries.length) {
        frag.appendChild(make('p', 'amb-q-label', 'Queued'));
        entries.slice(0, QUEUE_ROWS).forEach((entry) => {
          frag.appendChild(queueRow(entry.track, () => player.playQueued(entry.qid)));
        });
        if (entries.length > QUEUE_ROWS) frag.appendChild(make('p', 'amb-q-more', `and ${entries.length - QUEUE_ROWS} more`));
      }
      if (then.tracks.length) {
        frag.appendChild(make('p', 'amb-q-label', THEN_LABEL[then.kind] || 'Next'));
        then.tracks.slice(0, QUEUE_ROWS).forEach((track, i) => {
          frag.appendChild(queueRow(track, () => player.playUpcoming(i)));
        });
        if (then.more > 0) frag.appendChild(make('p', 'amb-q-more', `and ${then.more} more after those`));
      }
      queueBody.appendChild(frag);
    }

    queueCount.textContent = entries.length ? `${entries.length} queued` : '';
    queueBox.hidden = !(has && queueOn);
    queuePill.hidden = !(has && !queueOn);
    root.classList.toggle('has-queue', has && queueOn);
  }

  function setQueueOn(on) {
    queueOn = on;
    try { localStorage.setItem(QUEUE_KEY, on ? 'on' : 'off'); } catch { /* not kept */ }
    paintQueue();
    // The button that was pressed has just gone: put focus on the other
    const next = on ? queueX : queuePill;
    try { next.focus({ preventScroll: true }); } catch { /* hidden */ }
  }
  queueX.addEventListener('click', () => setQueueOn(false));
  queuePill.addEventListener('click', () => setQueueOn(true));

  if (typeof player.onUpNext === 'function') {
    player.onUpNext((next) => {
      upNext = next || upNext;
      paintQueue();
    });
  }

  /* ---------- Show and hide ---------- */

  function show() {
    if (on || !shownTrack) return;
    on = true;
    returnTo = document.activeElement;
    wantLyrics(slots[front]);
    paintProgress();
    root.classList.add('is-on');
    // The screen covers everything, so focus goes to the one control on
    // it. Without this a Tab would walk through the sidebar underneath.
    try { close.focus({ preventScroll: true }); } catch { /* not focusable yet */ }
    clearInterval(progTimer);
    progTimer = setInterval(paintProgress, 500);
  }

  function hide() {
    if (!on) return;
    on = false;
    dragging = false;
    line.classList.remove('is-drag');
    root.classList.remove('is-on');
    clearInterval(progTimer);
    clearTimeout(noteTimer);
    noteEl.classList.remove('is-shown');
    // Counted from now, so it does not come straight back
    lastInput = Date.now();
    const back = returnTo;
    returnTo = null;
    if (back && back.isConnected && typeof back.focus === 'function') {
      try { back.focus({ preventScroll: true }); } catch { /* gone */ }
    }
  }

  /* ---------- Input ---------- */

  /* While it is up, only Escape and the X put it away, and Tab is held
     on the X. The player keys (Space, the arrows) are js/hotkeys.js,
     which works the same with the screen down. A dialog that opens over
     it (the update pop-up) owns the keyboard, so Tab and Escape are its
     business and not this. */
  function onKey(event) {
    if (event.type !== 'keydown' || anyDialogOpen(frame)) return;

    if (event.key === 'Tab') {
      // Held inside the screen: the X, and "Try again" and "another
      // version" when they are there
      event.preventDefault();
      const stops = [close];
      if (!slots[front].back.hidden) stops.push(slots[front].back);
      if (!slots[front].retry.hidden) stops.push(slots[front].retry);
      if (!slots[front].other.hidden) stops.push(slots[front].other);
      // The Up next panel: its cross, or the button that brings it back,
      // then the songs in it
      if (!queueBox.hidden) stops.push(queueX, ...queueBox.querySelectorAll('.amb-q-go'));
      if (!queuePill.hidden) stops.push(queuePill);
      const at = stops.indexOf(document.activeElement);
      const step = event.shiftKey ? stops.length - 1 : 1;
      try { stops[(at + step) % stops.length].focus({ preventScroll: true }); } catch { /* fine */ }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      hide();
    }
  }

  function onInput(event) {
    if (on) {
      onKey(event);
      return;
    }
    lastInput = Date.now();
  }

  function listen(target) {
    INPUTS.forEach((type) => target.addEventListener(type, onInput, { capture: true }));
  }

  close.addEventListener('click', hide);

  listen(document);
  function listenFrame() {
    try { listen(frame.contentWindow); } catch { /* a page that will not say */ }
  }
  frame.addEventListener('load', listenFrame);
  listenFrame();

  /* ---------- Playback ---------- */

  player.onPlayback((now) => {
    playing = Boolean(now.playing);
    setTrack(now.track);
    // Nothing loaded (the bar's own close stops the player): there is
    // nothing left to show. A pause is not that, and leaves it up.
    if (!now.track) hide();
  });

  /* The two Settings choices: whether the screen may come up on its
     own, and after how long. The bar's button is not affected: that is
     asking for it. A player with no onSettings (an old harness) keeps
     the defaults. */
  let idleOn = true;
  let idleMs = IDLE_MS;
  if (typeof player.onSettings === 'function') {
    player.onSettings((p) => {
      idleOn = p.idle !== false;
      const s = Number(p.idleSeconds);
      idleMs = (Number.isFinite(s) && s >= 5 ? s : IDLE_MS / 1000) * 1000;
    });
  }

  setInterval(() => {
    if (!idleOn || on || !playing || !shownTrack || anyDialogOpen(frame)) return;
    if (Date.now() - lastInput >= idleMs) show();
  }, 1000);

  return { show, hide, note, isOn: () => on };
}
