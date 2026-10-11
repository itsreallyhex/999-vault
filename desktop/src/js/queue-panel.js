/* ============================================================
   The Up next panel.

   Opens from the bar's queue button and says what will play, in the
   order it will play: what is playing now, then the songs that were
   asked for (the queue, which can be taken out one at a time and
   cleared), then the songs that follow on their own: the rest of the
   playlist in its running order, or the one random song Next will pick
   in the Vault.

   The same song can be waiting more than once; each queue entry has
   its own id, so Remove takes out the row that was pressed and no
   other. The songs that follow on their own are read only: they are the
   running order, and changing it is shuffle's and repeat's business.

   shell.js only: the queue and the player live in the shell.
   ============================================================ */

import { make } from './utils.js';
import { makePopover } from './popover.js';

/** Queue rows drawn. A queue can be a whole category; the player keeps
    all of it, the panel shows the front and says how many are behind. */
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

/** The heading over the songs that follow on their own. */
const THEN_LABEL = {
  playlist: 'Next in this playlist',
  vault: 'Next, picked at random from the Vault',
  'repeat-one': 'Repeat is on, so this plays again'
};

/**
 * Start the panel.
 *
 *   player   the shell's player (onUpNext, onPlayback, removeFromQueue,
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

  // What was asked for
  const queueLabel = make('p', 'q-label', 'Queued');
  const list = make('ol', 'q-list');
  const empty = make('p', 'q-empty',
    'Nothing is queued. Add songs from the Vault or a playlist, and the same song can go in more than once.');

  // What follows on its own
  const thenWrap = make('div', 'q-then');
  const thenLabel = make('p', 'q-label', '');
  const thenList = make('ol', 'q-list q-up-list');
  const thenMore = make('p', 'q-more', '');
  thenWrap.append(thenLabel, thenList, thenMore);

  pop.body.append(now, queueLabel, list, empty, thenWrap);

  const clear = make('button', 'btn btn-ghost q-clear', 'Clear queue');
  clear.type = 'button';
  const count = make('span', 'q-count mono', '');
  pop.foot.append(count, clear);

  clear.addEventListener('click', () => player.clearQueue());

  function renderNow(snap) {
    const t = snap && snap.track;
    nowTitle.textContent = t ? t.t : 'Nothing is playing';
    nowMeta.textContent = t ? [t.c, snap.playing ? 'playing' : 'paused'].filter(Boolean).join('  ·  ') : '';
  }

  function row(className, n, track) {
    const li = make('li', className);
    li.appendChild(make('span', 'q-n mono', String(n).padStart(2, '0')));
    const text = make('span', 'q-text');
    text.appendChild(make('span', 'q-title', track.t));
    const meta = [track.c, track.len].filter(Boolean).join('  ·  ');
    if (meta) text.appendChild(make('span', 'q-meta', meta));
    li.appendChild(text);
    return li;
  }

  function render(next) {
    const entries = (next && next.queue) || [];
    const then = (next && next.then) || { kind: 'none', tracks: [], more: 0 };

    /* ---- the queue ---- */
    list.textContent = '';
    const frag = document.createDocumentFragment();
    entries.slice(0, SHOWN).forEach((entry, i) => {
      const li = row('q-row', i + 1, entry.track);
      li.dataset.qid = String(entry.qid);

      const cut = make('button', 'q-cut');
      cut.type = 'button';
      cut.appendChild(crossIcon());
      cut.appendChild(make('span', 'sr-only', `Remove ${entry.track.t} from the queue`));
      cut.addEventListener('click', () => player.removeFromQueue(entry.qid));
      li.appendChild(cut);

      frag.appendChild(li);
    });
    list.appendChild(frag);

    const behind = entries.length - SHOWN;
    if (behind > 0) list.appendChild(make('li', 'q-more', `and ${behind} more`));

    list.hidden = entries.length === 0;
    queueLabel.hidden = false;
    empty.hidden = entries.length !== 0;
    clear.hidden = entries.length === 0;

    /* ---- what follows on its own ---- */
    thenList.textContent = '';
    const upFrag = document.createDocumentFragment();
    then.tracks.forEach((track, i) => {
      const li = row('q-up', i + 1, track);
      li.dataset.kind = then.kind;
      upFrag.appendChild(li);
    });
    thenList.appendChild(upFrag);

    const shown = then.tracks.length > 0;
    thenWrap.hidden = !shown;
    thenLabel.textContent = THEN_LABEL[then.kind] || '';
    thenMore.hidden = !(then.more > 0);
    thenMore.textContent = then.more > 0 ? `and ${then.more} more after those` : '';

    count.textContent = entries.length
      ? `${entries.length} ${entries.length === 1 ? 'song' : 'songs'} queued`
      : '';
  }

  player.onUpNext(render);
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
