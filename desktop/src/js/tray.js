/* ============================================================
   The Up next tray.

   A strip of covers just above the player bar: the songs that were
   queued, numbered, then the ones that follow on their own, a little
   dimmer. It says what is coming without opening anything. Pressing a
   cover plays that song; the button at the end opens the full Up next
   sheet (js/queue-panel.js) and closes it again.

   The tray is only there when something is coming. body gets
   .has-tray while it shows, so the page frame and the panels that sit
   above the bar can make room for it (css/panels.css).

   shell.js only.
   ============================================================ */

import { make } from './utils.js';
import { buildCover } from './covers.js';

/** Covers drawn from each list. The strip clips what does not fit. */
const MAX_QUEUED = 12;
const MAX_UPCOMING = 12;

const NS = 'http://www.w3.org/2000/svg';

function chevron() {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M6 15l6-6 6 6');
  svg.appendChild(path);
  return svg;
}

/**
 * Start the tray.
 *
 *   player   the shell's player (onUpNext, onPlayback, playQueued,
 *            playUpcoming)
 *
 * Returns { el, isVisible } for a harness.
 */
export function initTray({ player }) {
  const root = make('section', 'tray');
  root.setAttribute('aria-label', 'Up next');
  root.hidden = true;

  const label = make('span', 'tray-label', 'Up next');
  const count = make('span', 'tray-count mono', '');
  const strip = make('ol', 'tray-strip');
  const more = make('span', 'tray-more mono', '');

  const toggle = make('button', 'tray-toggle');
  toggle.type = 'button';
  toggle.dataset.popToggle = 'queuePanel';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'queuePanel');
  const toggleText = make('span', '', 'Open queue');
  toggle.append(toggleText, chevron());

  root.append(label, count, strip, more, toggle);
  document.body.appendChild(root);

  let hasTrack = false;
  let last = { queue: [], then: { kind: 'none', tracks: [], more: 0 } };

  function item(track, onPlay, n) {
    const li = make('li', n ? 'tray-item is-queued' : 'tray-item');
    const go = make('button', 'tray-go');
    go.type = 'button';
    go.title = track.t;
    go.setAttribute('aria-label', `Play ${track.t}`);
    const shot = make('span', 'tray-shot');
    shot.appendChild(buildCover(track));
    go.appendChild(shot);
    if (n) go.appendChild(make('span', 'tray-n mono', String(n)));
    go.addEventListener('click', onPlay);
    li.appendChild(go);
    return li;
  }

  function render() {
    const entries = last.queue || [];
    const then = last.then || { tracks: [], more: 0 };
    const coming = entries.length + then.tracks.length;

    strip.textContent = '';
    const frag = document.createDocumentFragment();
    entries.slice(0, MAX_QUEUED).forEach((entry, i) => {
      frag.appendChild(item(entry.track, () => player.playQueued(entry.qid), i + 1));
    });
    then.tracks.slice(0, MAX_UPCOMING).forEach((track, i) => {
      frag.appendChild(item(track, () => player.playUpcoming(i), 0));
    });
    strip.appendChild(frag);

    count.textContent = entries.length
      ? `${entries.length} ${entries.length === 1 ? 'song' : 'songs'} queued`
      : '';

    const drawn = Math.min(entries.length, MAX_QUEUED) + Math.min(then.tracks.length, MAX_UPCOMING);
    const rest = (entries.length + then.tracks.length - drawn) + (then.more > 0 ? then.more : 0);
    more.textContent = rest > 0 ? `and ${rest} more` : '';
    more.hidden = rest <= 0;

    const show = hasTrack && coming > 0;
    root.hidden = !show;
    document.body.classList.toggle('has-tray', show);
  }

  toggle.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('nine:open-queue', { detail: { anchor: toggle } }));
  });

  // The button says what its press will do, whichever button opened it
  document.addEventListener('nine:popover', (event) => {
    const d = event.detail || {};
    if (d.id !== 'queuePanel') return;
    toggle.setAttribute('aria-expanded', String(Boolean(d.open)));
    toggleText.textContent = d.open ? 'Close queue' : 'Open queue';
    toggle.classList.toggle('is-open', Boolean(d.open));
  });

  player.onUpNext((next) => {
    last = next || last;
    render();
  });
  player.onPlayback((snap) => {
    const has = Boolean(snap && snap.track);
    if (has === hasTrack) return;
    hasTrack = has;
    render();
  });

  return { el: root, isVisible: () => !root.hidden };
}
