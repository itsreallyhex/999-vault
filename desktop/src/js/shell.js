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
     5. Asks the release page for a newer version, once, a few seconds
        after launch, and shows the pop-up if there is one.

   The order is the point. The global goes up before the frame exists,
   so there is no window in which a page could load, look for a host,
   find none and start its own player. Same origin throughout, so the
   pages call the host's functions directly; nothing is serialised.

   The pages stay pages. Their links navigate the frame, their modules
   tear down and rebuild exactly as before, and none of them knows
   whether it is framed except player.js, which checks once at load.
   ============================================================ */

import * as player from './player.js';
import { invoke, inTauri } from './tauri.js';

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

/* ---------- New release ----------
   update.rs does the checking, downloading and installing through
   Tauri's updater plugin; this is the pop-up and the two decisions
   around it. On launch the check runs once, after a short wait so it
   never competes with the first page, and only if the `updates`
   setting is on. Remind me later keeps that one version quiet for a
   day; a newer one after that shows again. Settings reaches the same
   check through window.__nine_updates, which is how Check now works.

   Under a plain browser there is no Rust and nothing here runs. */

const SNOOZE_KEY = '999:update-snooze';
const SNOOZE_FOR = 24 * 60 * 60 * 1000;
const CHECK_AFTER = 4000;

const up = {};
['update', 'updateVersion', 'updateCurrent', 'updateNotes', 'updateProgress',
  'updateBar', 'updateFill', 'updateStatus', 'updateGo', 'updateLater']
  .forEach((id) => { up[id] = document.getElementById(id); });

let offer = null;
let installing = false;

function snoozed(version) {
  try {
    const s = JSON.parse(localStorage.getItem(SNOOZE_KEY) || 'null');
    return Boolean(s && s.version === version && Date.now() < s.until);
  } catch {
    return false;
  }
}

function snooze(version) {
  try { localStorage.setItem(SNOOZE_KEY, JSON.stringify({ version, until: Date.now() + SNOOZE_FOR })); } catch { /* fine */ }
}

function openDialog() {
  if (typeof up.update.showModal === 'function') {
    if (!up.update.open) up.update.showModal();
  } else {
    up.update.open = true;
  }
}

function closeDialog() {
  if (typeof up.update.close === 'function' && up.update.open) up.update.close();
  else up.update.open = false;
}

function showOffer(info) {
  offer = info;
  up.updateVersion.textContent = info.version;
  up.updateCurrent.textContent = info.current;
  const notes = (info.notes || '').trim();
  up.updateNotes.textContent = notes;
  up.updateNotes.hidden = !notes;
  up.updateProgress.hidden = true;
  up.updateFill.style.width = '0';
  up.updateStatus.textContent = '';
  up.update.classList.remove('is-busy');
  openDialog();
  up.updateGo.focus();
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

function onProgress(payload) {
  if (!payload) return;
  if (payload.done) {
    up.updateFill.style.width = '100%';
    up.updateBar.setAttribute('aria-valuenow', '100');
    up.updateStatus.textContent = 'Installing, the app will reopen on its own';
    return;
  }
  const { got, total } = payload;
  if (total) {
    const pct = Math.min(100, Math.round((got / total) * 100));
    up.updateFill.style.width = `${pct}%`;
    up.updateBar.setAttribute('aria-valuenow', String(pct));
    up.updateStatus.textContent = `${mb(got)} of ${mb(total)}`;
  } else {
    up.updateStatus.textContent = mb(got);
  }
}

async function install() {
  if (!offer || installing) return;
  installing = true;
  up.update.classList.add('is-busy');
  up.updateProgress.hidden = false;
  up.updateStatus.textContent = 'Downloading';
  try {
    await invoke('update_install');
    // On Windows the installer takes over and this process exits
    // before the promise settles; the line above is what stays on
    // screen until then.
  } catch (err) {
    up.updateStatus.textContent = String(err);
    up.update.classList.remove('is-busy');
    installing = false;
  }
}

function later() {
  if (installing) return;
  if (offer) snooze(offer.version);
  closeDialog();
}

/**
 * Ask Rust. Resolves to what happened rather than throwing, so a
 * caller can turn it into a toast: { ok, error } on a failure,
 * { ok, available: false, current } when this is the latest,
 * { ok, available: true, version, snoozed } when there is a newer one.
 * The pop-up opens for a newer version unless it is snoozed and the
 * check was not asked for by hand.
 */
async function checkUpdates({ manual = false } = {}) {
  if (!inTauri) return { ok: false, error: 'Not running as the app' };
  let info;
  try {
    info = await invoke('update_check');
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  if (!info.available) return { ok: true, available: false, current: info.current };
  if (!manual && snoozed(info.version)) return { ok: true, available: true, snoozed: true, version: info.version };
  showOffer(info);
  return { ok: true, available: true, snoozed: false, version: info.version };
}

window.__nine_updates = { check: (manual = false) => checkUpdates({ manual }) };

if (up.update) {
  up.updateGo.addEventListener('click', install);
  up.updateLater.addEventListener('click', later);
  // Escape, or a click outside the panel, is Remind me later. Neither
  // is allowed once the download has started.
  up.update.addEventListener('cancel', (event) => { event.preventDefault(); later(); });
  up.update.addEventListener('click', (event) => {
    if (!event.target.closest('.update-in')) later();
  });
}

if (inTauri) {
  setTimeout(() => {
    invoke('settings_get')
      .then((s) => { if (!s || s.updates !== false) return checkUpdates(); return null; })
      .catch(() => { /* an old binary, or offline: nothing to say on launch */ });
  }, CHECK_AFTER);
}

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
    events.listen('update-progress', (event) => onProgress(event.payload));
  }
} catch {
  // No bridge: a plain browser, or a build without the watcher. Ctrl+R
  // still works.
}
