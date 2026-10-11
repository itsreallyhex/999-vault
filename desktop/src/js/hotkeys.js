/* ============================================================
   Keyboard shortcuts for the player, everywhere in the app.

     Space            play or pause
     Left, Right      previous, next
     Ctrl+Left        volume down      Ctrl+Right   volume up

   shell.js only. The shell owns the player, and the pages are in a
   frame, which is another document: a key pressed on the Vault never
   reaches a listener on the shell's document. So this listens on both
   and re-attaches to the frame's window after every load, the same
   way ambient.js does for its idle clock.

   What it stays out of, because those keys mean something else there:

     - a text field, a select or a slider (the caret, the options, the
       slider's own arrows)
     - an open <dialog> (the picker, the update pop-up, the Vault's
       panel when it is one): a modal owns the keyboard
     - Shift or Alt chords, and Ctrl+Space
     - an IME composition
     - a window with nothing loaded: Right would start a random track
       from nowhere, and Space should still scroll the page

   Space is taken even when a button has focus. That is deliberate:
   after pressing a card's play button the focus stays on it, and
   Space would press it again instead of pausing. Enter still presses
   a button. Held keys repeat, which is right for the volume and wrong
   for skipping, so Space and the track keys take the first press only.
   ============================================================ */

/** One press of Ctrl+Left or Ctrl+Right moves the volume this far. */
const VOLUME_STEP = 0.05;

/** Whether a <dialog> is open in the shell or in the page in the frame. */
export function anyDialogOpen(frame) {
  if (document.querySelector('dialog[open]')) return true;
  try {
    return Boolean(frame && frame.contentDocument && frame.contentDocument.querySelector('dialog[open]'));
  } catch {
    return false;
  }
}

/** Whether a key pressed on this element belongs to the element. */
function typing(target) {
  if (!target || target.nodeType !== 1) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest && target.closest('[role="slider"], [role="textbox"], [role="combobox"], [role="listbox"]'));
}

/**
 * Start the shortcuts.
 *
 *   player    the shell's player (onPlayback, toggle, next, previous,
 *             nudgeVolume)
 *   frame     the iframe the pages are shown in
 *   screenUp  () => boolean: the idle screen is showing, and owns the
 *             keyboard. Focus is on its X, a button, which would
 *             otherwise be skipped by the typing rule.
 *   onAction  (text) => void: what a key just did, for the idle
 *             screen's readout. Nothing needs it while the bar shows
 *             the same change.
 */
export function initHotkeys({ player, frame, screenUp = () => false, onAction = () => {} }) {
  let playing = false;
  let loaded = false;
  let swallowSpaceUp = false;

  player.onPlayback((now) => {
    playing = Boolean(now.playing);
    loaded = Boolean(now.track);
  });

  function onKeyDown(event) {
    if (!loaded || event.isComposing || event.altKey || event.shiftKey) return;

    const space = event.key === ' ';
    const left = event.key === 'ArrowLeft';
    const right = event.key === 'ArrowRight';
    if (!space && !left && !right) return;

    const ctrl = event.ctrlKey || event.metaKey;
    if (space && ctrl) return;

    if (anyDialogOpen(frame)) return;
    if (!screenUp() && typing(event.target)) return;

    // Ours. Stopped here so the bar's own key handler, which also
    // answers Space and the arrows when focus is inside it, does not
    // run a second time and cancel this one out.
    event.preventDefault();
    event.stopPropagation();

    if (space) {
      swallowSpaceUp = true;
      if (event.repeat) return;
      const wasPlaying = playing;
      player.toggle();
      onAction(wasPlaying ? 'Paused' : 'Playing');
    } else if (ctrl) {
      const level = player.nudgeVolume(right ? VOLUME_STEP : -VOLUME_STEP);
      onAction(level === 0 ? 'Volume off' : `Volume ${Math.round(level * 100)}%`);
    } else if (!event.repeat) {
      if (right) player.next();
      else player.previous();
    }
  }

  // A button is clicked by Space on release. Preventing the key-down
  // is enough in Chromium; this is the belt for the one press that
  // started somewhere this did not see.
  function onKeyUp(event) {
    if (event.key !== ' ' || !swallowSpaceUp) return;
    swallowSpaceUp = false;
    event.preventDefault();
    event.stopPropagation();
  }

  function listen(target) {
    target.addEventListener('keydown', onKeyDown, { capture: true });
    target.addEventListener('keyup', onKeyUp, { capture: true });
  }

  listen(document);
  function listenFrame() {
    try { listen(frame.contentWindow); } catch { /* a page that will not say */ }
  }
  frame.addEventListener('load', listenFrame);
  listenFrame();
}
