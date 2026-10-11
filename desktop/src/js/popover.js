/* ============================================================
   A panel that opens above the bar, anchored to the button that
   asked for it.

   Not a <dialog>: a modal would put the whole app behind a backdrop
   and take the keyboard, and these are things you tweak while the
   music plays. One panel is open at a time. Escape closes it, and so
   does a press anywhere outside it, including inside the page frame,
   which is another document and has to be listened to separately.

   shell.js only. The panels live in the shell's document because the
   bar and the player do.
   ============================================================ */

import { make } from './utils.js';

const NS = 'http://www.w3.org/2000/svg';

/** Every popover made, so opening one can close the others. */
const all = new Set();

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
 * Make a panel.
 *
 *   id      the element id
 *   title   the heading, and the accessible name
 *   frame   the iframe the pages are shown in, so a press in a page
 *           also counts as "outside"
 *   wide    a wider panel, for the sound lab
 *
 * Returns { el, body, foot, open, close, toggle, isOpen }. The caller
 * fills `body` (and `foot`) once and updates them in place.
 */
export function makePopover({ id, title, frame = null, wide = false }) {
  const root = make('section', `pop${wide ? ' pop-wide' : ''}`);
  root.id = id;
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', title);

  const head = make('header', 'pop-head');
  head.appendChild(make('h2', 'pop-title', title));
  const closeBtn = make('button', 'pop-close');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', `Close ${title}`);
  closeBtn.appendChild(crossIcon());
  head.appendChild(closeBtn);

  const body = make('div', 'pop-body');
  const foot = make('footer', 'pop-foot');
  root.append(head, body, foot);
  document.body.appendChild(root);

  let anchor = null;

  const api = {
    el: root,
    body,
    foot,
    get isOpen() { return !root.hidden; },

    open(from) {
      all.forEach((p) => { if (p !== api) p.close(false); });
      anchor = from || null;
      root.hidden = false;
      if (anchor) anchor.setAttribute('aria-expanded', 'true');
    },

    close(giveFocusBack = true) {
      if (root.hidden) return;
      root.hidden = true;
      if (anchor) {
        anchor.setAttribute('aria-expanded', 'false');
        if (giveFocusBack && anchor.isConnected && typeof anchor.focus === 'function') {
          try { anchor.focus({ preventScroll: true }); } catch { /* gone */ }
        }
      }
      anchor = null;
    },

    toggle(from) {
      if (root.hidden) api.open(from);
      else api.close();
    }
  };

  closeBtn.addEventListener('click', () => api.close());

  // Escape, while this panel is the open one. Capture, so a page that
  // handles Escape for itself does not also act on this press.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || root.hidden) return;
    event.preventDefault();
    api.close();
  }, true);

  // A press outside closes it. The anchor is "inside": its own click
  // is the toggle, and closing here first would reopen it.
  const outside = (event) => {
    if (root.hidden) return;
    const t = event.target;
    if (t && t.nodeType === 1) {
      if (root.contains(t)) return;
      if (anchor && anchor.contains(t)) return;
    }
    api.close(false);
  };
  document.addEventListener('pointerdown', outside, true);

  function listenFrame() {
    try { frame.contentWindow.addEventListener('pointerdown', outside, true); } catch { /* not ours */ }
  }
  if (frame) {
    frame.addEventListener('load', listenFrame);
    listenFrame();
  }

  all.add(api);
  return api;
}
