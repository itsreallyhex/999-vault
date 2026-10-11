/* ============================================================
   The Up next panel.

   Opens from the bar's queue button. Shows what is playing and what
   is waiting, in the order it will play, with a way to take one entry
   out and a way to clear the lot. The same song can be waiting more
   than once; each entry has its own id, so Remove takes out the row
   that was pressed and no other.

   shell.js only: the queue and the player live in the shell.
   ============================================================ */

import { make } from './utils.js';
import { makePopover } from './popover.js';

/** Rows drawn. A queue can be a whole category; the player keeps all
    of it, the panel shows the front and says how many are behind. */
const SHOWN = 200;

const NS = 'http://www.w3.org/2000/svg';

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
 * Start the panel.
 *
 *   player   the shell's player (onQueue, onPlayback, removeFromQueue,
 *            clearQueue)
 *   frame    the iframe the pages are shown in
 *
 * Returns { open, close, toggle, isOpen } for a harness.
 */
export function initQueuePanel({ player, frame }) {
  const pop = makePopover({ id: 'queuePanel', title: 'Up next', frame });
  pop.el.classList.add('pop-queue');

  const now = make('div', 'q-now');
  const nowLabel = make('p', 'q-label', 'Now playing');
  const nowTitle = make('p', 'q-now-title', 'Nothing is playing');
  const nowMeta = make('p', 'q-meta');
  now.append(nowLabel, nowTitle, nowMeta);

  const label = make('p', 'q-label', 'Waiting');
  const list = make('ol', 'q-list');
  const empty = make('p', 'q-empty',
    'Nothing is queued. Add songs from the Vault or a playlist, and the same song can go in more than once.');
  pop.body.append(now, label, list, empty);

  const clear = make('button', 'btn btn-ghost q-clear', 'Clear all');
  clear.type = 'button';
  const count = make('span', 'q-count mono', '');
  pop.foot.append(count, clear);

  clear.addEventListener('click', () => player.clearQueue());

  function renderNow(snap) {
    const t = snap && snap.track;
    nowTitle.textContent = t ? t.t : 'Nothing is playing';
    nowMeta.textContent = t ? [t.c, snap.playing ? 'playing' : 'paused'].filter(Boolean).join('  ·  ') : '';
  }

  function render(entries) {
    list.textContent = '';
    const frag = document.createDocumentFragment();

    entries.slice(0, SHOWN).forEach((entry, i) => {
      const li = make('li', 'q-row');
      li.dataset.qid = String(entry.qid);
      li.appendChild(make('span', 'q-n mono', String(i + 1).padStart(2, '0')));

      const text = make('span', 'q-text');
      text.appendChild(make('span', 'q-title', entry.track.t));
      const meta = [entry.track.c, entry.track.len].filter(Boolean).join('  ·  ');
      if (meta) text.appendChild(make('span', 'q-meta', meta));
      li.appendChild(text);

      const cut = make('button', 'q-cut');
      cut.type = 'button';
      cut.appendChild(crossIcon());
      cut.appendChild(make('span', 'sr-only', `Remove ${entry.track.t} from the queue`));
      cut.addEventListener('click', () => player.removeFromQueue(entry.qid));
      li.appendChild(cut);

      frag.appendChild(li);
    });
    list.appendChild(frag);

    const more = entries.length - SHOWN;
    if (more > 0) {
      const li = make('li', 'q-more', `and ${more} more`);
      list.appendChild(li);
    }

    list.hidden = entries.length === 0;
    label.hidden = entries.length === 0;
    empty.hidden = entries.length !== 0;
    clear.hidden = entries.length === 0;
    count.textContent = entries.length
      ? `${entries.length} ${entries.length === 1 ? 'song' : 'songs'} waiting`
      : '';
  }

  player.onQueue(render);
  player.onPlayback(renderNow);

  document.addEventListener('nine:open-queue', (event) => {
    const anchor = event.detail && event.detail.anchor;
    pop.toggle(anchor);
  });

  return {
    open: (a) => pop.open(a),
    close: () => pop.close(),
    toggle: (a) => pop.toggle(a),
    isOpen: () => pop.isOpen
  };
}
