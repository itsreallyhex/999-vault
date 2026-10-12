/* ============================================================
   The Up next panel.

   Opens from the bar's queue button and says what will play, in the
   order it will play, with the covers: what is playing now, then the
   songs that were asked for (the queue), then the songs that follow on
   their own: the rest of the playlist in its running order, or the one
   random song Next will pick in the Vault.

   Pressing a song plays it, and the ones after it follow:
     a queued song     plays now; the queued songs before it are
                       skipped and the ones after it stay queued
     a playlist song   plays now and the running order carries on from
                       it; whatever is queued still plays after it
     the Vault pick    plays now
   A queued song also has a cross, which takes only that one out. The
   same song can be queued more than once; every queue entry has its
   own id, so a cross takes out the row that was pressed and no other.

   shell.js only: the queue and the player live in the shell.
   ============================================================ */

import { make } from './utils.js';
import { buildCover } from './covers.js';
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
 *            clearQueue, playQueued, playUpcoming)
 *   frame    the iframe the pages are shown in
 *
 * Returns { open, close, toggle, isOpen } for a harness.
 */
export function initQueuePanel({ player, frame }) {
  const pop = makePopover({ id: 'queuePanel', title: 'Up next', frame });
  pop.el.classList.add('pop-queue');

  /* ---- now playing ---- */
  const now = make('div', 'q-now');
  const nowShot = make('span', 'q-shot q-shot-lg');
  const nowText = make('div', 'q-now-text');
  const nowLabel = make('p', 'q-label', 'Now playing');
  const nowTitle = make('p', 'q-now-title', 'Nothing is playing');
  const nowMeta = make('p', 'q-meta');
  // How far into it: moved twice a second while the panel is open
  const nowBar = make('div', 'q-now-bar mono');
  const nowAt = make('span', '', '0:00');
  const nowLine = make('span', 'q-now-line');
  const nowFill = make('i');
  nowLine.appendChild(nowFill);
  const nowTotal = make('span', '', '0:00');
  nowBar.append(nowAt, nowLine, nowTotal);
  nowText.append(nowLabel, nowTitle, nowMeta, nowBar);
  now.append(nowShot, nowText);

  /* ---- what was asked for ---- */
  const queueLabel = make('p', 'q-label', 'Queued');
  const list = make('ol', 'q-list');
  const empty = make('p', 'q-empty',
    'Nothing is queued. Add songs from the Vault or a playlist, and the same song can go in more than once.');

  /* ---- what follows on its own ---- */
  const thenWrap = make('div', 'q-then');
  const thenLabel = make('p', 'q-label', '');
  const thenList = make('ol', 'q-list q-up-list');
  const thenMore = make('p', 'q-more', '');
  thenWrap.append(thenLabel, thenList, thenMore);

  // Three columns: what is playing, what was asked for, what follows.
  // The clear button and the count sit with the queue they belong to.
  const clear = make('button', 'btn btn-ghost q-clear', 'Clear queue');
  clear.type = 'button';
  const count = make('span', 'q-count mono', '');
  const queueHead = make('div', 'q-head');
  queueHead.append(queueLabel, count, clear);
  const queueCol = make('div', 'q-col');
  queueCol.append(queueHead, list, empty);
  pop.body.append(now, queueCol, thenWrap);

  clear.addEventListener('click', () => player.clearQueue());

  /** The track the big cover was last drawn for, so a pause or a
      play does not redraw an image. */
  let shownNow = null;

  function renderNow(snap) {
    const t = snap && snap.track;
    nowTitle.textContent = t ? t.t : 'Nothing is playing';
    nowMeta.textContent = t ? [t.c, snap.playing ? 'playing' : 'paused'].filter(Boolean).join('  ·  ') : '';
    if (t !== shownNow) {
      shownNow = t;
      nowShot.textContent = '';
      if (t) nowShot.appendChild(buildCover(t));
    }
  }

  /** One song: its place, its cover, its title. A button, so a press
      plays it and the keyboard can reach it. */
  function row(className, n, track, onPlay) {
    const li = make('li', className);

    const go = make('button', 'q-go');
    go.type = 'button';
    go.setAttribute('aria-label', `Play ${track.t}`);
    go.appendChild(make('span', 'q-n mono', String(n).padStart(2, '0')));

    const shot = make('span', 'q-shot');
    shot.appendChild(buildCover(track));
    go.appendChild(shot);

    const text = make('span', 'q-text');
    text.appendChild(make('span', 'q-title', track.t));
    const meta = [track.c, track.len].filter(Boolean).join('  ·  ');
    if (meta) text.appendChild(make('span', 'q-meta', meta));
    go.appendChild(text);

    go.addEventListener('click', onPlay);
    li.appendChild(go);
    return li;
  }

  function render(next) {
    const entries = (next && next.queue) || [];
    const then = (next && next.then) || { kind: 'none', tracks: [], more: 0 };

    /* ---- the queue ---- */
    list.textContent = '';
    const frag = document.createDocumentFragment();
    entries.slice(0, SHOWN).forEach((entry, i) => {
      const li = row('q-row', i + 1, entry.track, () => player.playQueued(entry.qid));
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
      const li = row('q-up', i + 1, track, () => player.playUpcoming(i));
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

  /* The progress line under the title. The player says nothing about it
     between plays, so it is read while the panel is open and not at all
     when it is shut. */
  const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  function paintBar() {
    const t = typeof player.timing === 'function' ? player.timing() : null;
    if (!t) return;
    nowAt.textContent = clock(t.at || 0);
    nowTotal.textContent = t.total > 0 ? clock(t.total) : '';
    nowFill.style.width = t.total > 0 ? `${Math.min(100, (t.at / t.total) * 100)}%` : '0%';
  }
  let tick = null;
  document.addEventListener('nine:popover', (event) => {
    const d = event.detail || {};
    if (d.id !== 'queuePanel') return;
    clearInterval(tick);
    tick = null;
    if (d.open) {
      paintBar();
      tick = setInterval(paintBar, 500);
    }
  });

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
