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
frame.src = 'index.html';

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
  try {
    document.title = frame.contentDocument.title || '999';
    frame.contentWindow.addEventListener('keydown', reloadKeys);
  } catch {
    // A page that will not say: keep the mark
  }
});

document.body.prepend(frame);

/* ---------- Live reload ----------
   watch.rs emits `pages-changed` with the files that moved, relative
   to the pages folder, when the pages come from a checkout. What to do
   depends on what changed:

     .css            swap the <link> in place, in whichever document
                     holds it. No reload, nothing lost, the music plays.
     the shell's own files (shell.html, shell.js, player.js and what
     player.js imports, shell.css, player.css)
                     reload the shell. The player restarts from its
                     resume snapshot, paused if autoplay is refused.
     anything else   reload the frame. The player never notices.

   app.css is loaded by the shell as well as the pages, but a stylesheet
   swap handles it, so it never forces a shell reload. */

const SHELL_FILES = new Set([
  'shell.html', 'js/shell.js', 'js/player.js',
  // player.js imports, any of which changes the player's behaviour
  'js/config.js', 'js/tauri.js', 'js/utils.js', 'js/covers.js', 'js/ui.js', 'js/db.js'
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
