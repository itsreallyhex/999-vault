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
// with no shell in the way
frame.addEventListener('load', () => {
  try {
    document.title = frame.contentDocument.title || '999';
  } catch {
    // A page that will not say: keep the mark
  }
});

document.body.prepend(frame);
