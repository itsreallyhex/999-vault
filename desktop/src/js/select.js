/* ============================================================
   Select several songs, then add them to the queue in one go.

   Shared by the Vault and the playlists page. The page owns what a
   "song" is and how a row or a card is marked; this owns the state
   (what is picked, whether the mode is on), the Select button and the
   bar that appears with a count and the actions.

   In the mode the page makes a press on a card or row toggle it
   instead of opening or playing it. Picks are kept by a key the page
   chooses, so they survive a redraw (a filter, "load more").

   The queue itself, with repeats allowed, is player.js. A selection
   only ever hands it an ordered list.
   ============================================================ */

import { make } from './utils.js';

/**
 * @param {object}   o
 * @param {Element}  o.parent    where the Select button goes
 * @param {Element}  o.scope     gets the class `is-selecting` while on
 * @param {function} o.keyOf     item => a stable key
 * @param {function} [o.ordered] () => every item, in the order they
 *                               should be queued. Without it, picks go
 *                               in the order they were made.
 * @param {function} [o.every]   () => the items "Select all" takes (what
 *                               is shown right now)
 * @param {function} o.onQueue   (items) => how many are waiting after
 * @param {number}   [o.cap]     most songs one press adds
 * @param {function} [o.say]     (text) => void, a line of feedback
 */
export function createSelect({ parent, scope, keyOf, ordered, every, onQueue, cap = 500, say = () => {} }) {
  const picked = new Map();
  let on = false;
  const listeners = new Set();

  const toggleBtn = make('button', 'btn btn-ghost sel-toggle', 'Select songs');
  toggleBtn.type = 'button';
  toggleBtn.setAttribute('aria-pressed', 'false');
  parent.appendChild(toggleBtn);

  const bar = make('div', 'sel-bar');
  bar.hidden = true;
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Selected songs');
  const count = make('span', 'sel-count mono', '0 selected');
  count.setAttribute('role', 'status');
  count.setAttribute('aria-live', 'polite');
  const add = make('button', 'btn btn-primary sel-add', 'Add to queue');
  add.type = 'button';
  const all = make('button', 'btn btn-ghost sel-all', 'Select all shown');
  all.type = 'button';
  all.hidden = typeof every !== 'function';
  const clear = make('button', 'btn btn-ghost sel-clear', 'Clear');
  clear.type = 'button';
  const done = make('button', 'btn btn-ghost sel-done', 'Done');
  done.type = 'button';
  bar.append(count, add, all, clear, done);
  document.body.appendChild(bar);

  function changed() {
    const n = picked.size;
    count.textContent = `${n} selected`;
    add.disabled = n === 0;
    clear.disabled = n === 0;
    listeners.forEach((fn) => {
      try { fn(); } catch { /* a page's marking must not break selecting */ }
    });
  }

  function setActive(next) {
    on = next;
    scope.classList.toggle('is-selecting', on);
    toggleBtn.setAttribute('aria-pressed', String(on));
    toggleBtn.textContent = on ? 'Stop selecting' : 'Select songs';
    bar.hidden = !on;
    if (!on) picked.clear();
    changed();
  }

  const api = {
    button: toggleBtn,
    active: () => on,
    size: () => picked.size,
    has: (item) => picked.has(keyOf(item)),

    /** Pick, or put back. */
    toggle(item) {
      const k = keyOf(item);
      if (picked.has(k)) picked.delete(k);
      else picked.set(k, item);
      changed();
      return picked.has(k);
    },

    set(items) {
      items.forEach((item) => picked.set(keyOf(item), item));
      changed();
    },

    clear() {
      picked.clear();
      changed();
    },

    /** The picks, in queue order. */
    items() {
      if (typeof ordered === 'function') {
        const have = new Set(picked.keys());
        const list = [];
        ordered().forEach((item) => {
          const k = keyOf(item);
          if (have.has(k)) { list.push(item); have.delete(k); }
        });
        // Anything picked that the page no longer lists still goes
        picked.forEach((item, k) => { if (have.has(k)) list.push(item); });
        return list;
      }
      return [...picked.values()];
    },

    /** Called after every change, so a page can re-mark what is on
        screen. */
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    stop() { setActive(false); }
  };

  toggleBtn.addEventListener('click', () => setActive(!on));
  done.addEventListener('click', () => setActive(false));
  clear.addEventListener('click', () => api.clear());
  all.addEventListener('click', () => {
    if (typeof every !== 'function') return;
    api.set(every().slice(0, cap));
  });

  add.addEventListener('click', () => {
    let list = api.items();
    if (!list.length) return;
    const trimmed = list.length > cap;
    if (trimmed) list = list.slice(0, cap);
    const waiting = onQueue(list);
    api.clear();
    const n = list.length;
    say(`${n} ${n === 1 ? 'song' : 'songs'} added to the queue`
      + (trimmed ? `, the first ${cap} of your picks` : '')
      + (Number.isFinite(waiting) && waiting > 0 ? ` (${waiting} waiting)` : ''));
  });

  // Escape leaves the mode, unless something that owns Escape is open
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !on) return;
    if (document.querySelector('dialog[open]')) return;
    const tag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    setActive(false);
  });

  changed();
  return api;
}
