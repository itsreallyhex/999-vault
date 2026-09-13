/* ============================================================
   The shell.

   Entry point for shell.html, which is what the window opens. It
   does three things and then gets out of the way:

     1. Puts this document's player.js on window.__nine_player, so a
        page loaded in the frame finds it and forwards to it instead
        of building a bar and an <audio> element of its own.
     2. Starts the player: the bar mounts here, on the shell's body,
        under the frame.
     3. Makes the frame and points it at the overview.
     4. Keeps the sidebar's current tab in step with the frame.

   The order is the point. The global goes up before the frame exists,
   so there is no window in which a page could load, look for a host,
   find none and start its own player. Same origin throughout, so the
   pages call the host's functions directly; nothing is serialised.

   The pages stay pages. Their links navigate the frame, their modules
   tear down and rebuild exactly as before, and none of them knows
   whether it is framed except player.js, which checks once at load.
   ============================================================ */

import * as player from './player.js';

window.__nine_player = player;

player.initPlayer();

const frame = document.createElement('iframe');
frame.className = 'shell-frame';
frame.id = 'frame';
frame.title = '999';
// The sidebar links carry target="frame", so the name is what lets a
// plain <a> navigate the page in the frame with no script in between.
frame.name = 'frame';
frame.src = 'index.html';

/* ---------- The sidebar ----------
   The tabs are markup in shell.html. All this does is mark the one
   the frame is showing, read off the frame's URL after every load,
   so a page reached some other way (the doors on the overview, a
   brand click, a link inside a page) is marked as well. */
const tabs = [...document.querySelectorAll('.side-tab[data-page]')];

function markTab(page) {
  tabs.forEach((tab) => {
    if (tab.dataset.page === page) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
}

function framePage() {
  try {
    const path = frame.contentWindow.location.pathname;
    return path.split('/').pop() || 'index.html';
  } catch {
    return null;
  }
}

// Mark on the click as well, so the tab answers before the page has
// loaded rather than a beat after.
tabs.forEach((tab) => tab.addEventListener('click', () => markTab(tab.dataset.page)));

/* ---------- The bar's buttons that reach into the frame ----------
   The player never learns what the frame is. It raises an event for
   the artwork click and opens its own dialog for the add button; the
   two lines below are the shell's side of each. */

// Artwork click: show the record in the Vault. The id opens the
// panel; the title is the search the Vault falls back to for a row
// saved before ids were stored.
document.addEventListener('nine:open-track', (event) => {
  const { rid, title } = event.detail || {};
  const params = new URLSearchParams();
  if (rid) params.set('rid', rid);
  if (title) params.set('q', title);
  frame.src = `vault.html?${params}`;
  markTab('vault.html');
});

// The add dialog lives in this document. When it closes, the page in
// the frame may be the playlists page showing a list that just grew,
// so it is told; every other page ignores the event.
const picker = document.getElementById('picker');
if (picker) {
  picker.addEventListener('close', () => {
    try { frame.contentWindow.dispatchEvent(new Event('playlists-changed')); } catch { /* not ours */ }
  });
}

// The window title follows the page in the frame, as it would have
// with no shell in the way. And the pages come off disk, so a reload is
// how an edit arrives: Ctrl+R or F5 inside the frame reloads the page
// in it, leaving the player alone; Ctrl+Shift+R reloads the shell too.
function reloadKeys(event) {
  const r = event.key === 'r' || event.key === 'R';
  if (event.key === 'F5' || (r && (event.ctrlKey || event.metaKey))) {
    event.preventDefault();
    if (event.shiftKey) window.location.reload();
    else frame.contentWindow.location.reload();
  }
}
document.addEventListener('keydown', reloadKeys);

frame.addEventListener('load', () => {
  const page = framePage();
  if (page) markTab(page);
  try {
    document.title = frame.contentDocument.title || '999';
    frame.contentWindow.addEventListener('keydown', reloadKeys);
  } catch {
    // A page that will not say: keep the mark
  }
});

// After the sidebar, which is markup: the shell body is a row, and
// the frame's place in it is its place on screen. prepend() put it in
// front of the sidebar, which is how the sidebar first came up on the
// right.
document.querySelector('.side-nav').after(frame);

/* ---------- Live reload ----------
   watch.rs emits `pages-changed` with the files that moved, relative
   to the pages folder, when the pages come from a checkout. What to do
   depends on what changed:

     .css            swap the <link> in place, in whichever document
                     holds it. No reload, nothing lost, the music plays.
     the shell's own files (shell.html, shell.js, player.js and what
     player.js imports)
                     reload the shell. The player restarts from its
                     resume snapshot, paused if autoplay is refused.
     anything else   reload the frame. The player never notices.

   app.css is loaded by the shell as well as the pages, but a stylesheet
   swap handles it, so it never forces a shell reload. */

const SHELL_FILES = new Set([
  'shell.html', 'js/shell.js', 'js/player.js',
  // player.js imports, any of which changes the player's behaviour
  'js/config.js', 'js/tauri.js', 'js/utils.js', 'js/covers.js', 'js/ui.js', 'js/db.js',
  'js/picker.js'
]);

function swapStylesheet(doc, file) {
  if (!doc) return false;
  let hit = false;
  doc.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
    const href = link.getAttribute('href') || '';
    if (href.split('?')[0] !== file) return;
    link.setAttribute('href', `${file}?t=${Date.now()}`);
    hit = true;
  });
  return hit;
}

function onPagesChanged(files) {
  const css = files.filter((f) => f.endsWith('.css'));
  const rest = files.filter((f) => !f.endsWith('.css'));

  css.forEach((f) => {
    swapStylesheet(document, f);
    try { swapStylesheet(frame.contentDocument, f); } catch { /* not ours to touch */ }
  });

  if (!rest.length) return;
  if (rest.some((f) => SHELL_FILES.has(f))) {
    window.location.reload();
  } else {
    try { frame.contentWindow.location.reload(); } catch { window.location.reload(); }
  }
}

try {
  const events = window.__TAURI__ && window.__TAURI__.event;
  if (events) {
    events.listen('pages-changed', (event) => {
      const files = Array.isArray(event.payload) ? event.payload : [];
      if (files.length) onPagesChanged(files);
    });
  }
} catch {
  // No bridge: a plain browser, or a build without the watcher. Ctrl+R
  // still works.
}
