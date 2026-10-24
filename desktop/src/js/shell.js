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
import { initAmbient } from './ambient.js';
import { initHotkeys } from './hotkeys.js';
import { initQueuePanel } from './queue-panel.js';
import { initLabPanel } from './lab-panel.js';
import { initTray } from './tray.js';
import { initSync } from './sync.js';
import { invoke, inTauri } from './tauri.js';

window.__nine_player = player;

player.initPlayer();

/* ---------- The bar's real height ----------
   --mini-h is the bar's minimum, and with a subtitle, a note and the
   via API pill the bar is taller than that. The frame's margin has to
   match what is on screen or the bottom of every page sits under the
   bar, so the bar is measured and --bar-h follows it. A separate
   variable, because writing --mini-h back would raise the bar's own
   min-height and it could never shrink again. */
{
  const bar = document.querySelector('.mini');
  const measure = () => {
    document.documentElement.style.setProperty('--bar-h', `${bar.hidden ? 0 : bar.offsetHeight}px`);
  };
  if (bar) {
    // jsdom has no ResizeObserver; the CSS falls back to --mini-h there
    if (typeof ResizeObserver === 'function') new ResizeObserver(measure).observe(bar);
    measure();
  }
}

/* ---------- Toast ----------
   A page's own toast would be clipped by the frame's edge, so a framed
   page hands the text up and the shell shows it over the bar, which is
   always in view. window.__nine_toast(text, bad). */
const toast = document.createElement('p');
toast.className = 'shell-toast';
toast.setAttribute('role', 'status');
toast.setAttribute('aria-live', 'polite');
document.body.appendChild(toast);
let toastTimer = null;
window.__nine_toast = (text, bad = false) => {
  clearTimeout(toastTimer);
  toast.textContent = text;
  toast.dataset.state = bad ? 'bad' : '';
  toast.classList.add('is-shown');
  toastTimer = setTimeout(() => toast.classList.remove('is-shown'), bad ? 6000 : 2200);
};

/* ---------- The link out ----------
   The GitHub link in the sidebar has to open in the system browser: a
   plain navigation would load GitHub inside the window, and the
   webview never opens a new window. Under Tauri that is the shell
   plugin's open, allowed for http(s) by shell:default in the
   capabilities; a bare browser gets a normal new tab. */
const github = document.getElementById('sideGithub');
if (github) {
  github.addEventListener('click', (event) => {
    event.preventDefault();
    const url = github.href;
    if (inTauri) {
      invoke('plugin:shell|open', { path: url }).catch((err) => {
        window.__nine_toast(`Could not open the browser: ${err.message || err}`, true);
      });
    } else {
      window.open(url, '_blank', 'noopener');
    }
  });
}

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

/* ---------- The idle screen ----------
   After the frame is in the document, so there is a window to listen
   on. See js/ambient.js. Exposed for the harness, which cannot wait
   thirty seconds for it. */
const ambient = initAmbient({ player, frame });
window.__nine_ambient = ambient;

/* ---------- Keyboard shortcuts ----------
   Space, the arrows and Ctrl+arrows, on every page and on the idle
   screen. See js/hotkeys.js for what it stands aside for. */
initHotkeys({ player, frame, screenUp: ambient.isOn, onAction: ambient.note });

// The bar's expand button: the screen now, not after thirty seconds.
document.addEventListener('nine:open-screen', () => ambient.show());

/* ---------- The panels over the bar ----------
   Up next, the sound lab and the sleep timer. Each listens for the
   event its bar button raises (nine:open-queue, nine:open-lab,
   nine:open-sleep). Exposed for the harness. */
window.__nine_panels = {
  queue: initQueuePanel({ player, frame }),
  ...initLabPanel({ player, frame })
};

/* The strip of covers over the bar, and its button for the Up next
   sheet above. See js/tray.js. */
window.__nine_tray = initTray({ player });

/* ---------- Sync ----------
   Playlists and history, kept level with the phone through the owner's
   own server. Off until Settings holds an address and a token; then it
   runs here, in the one document that stays open, and the pages reach
   it as window.parent.__nine_sync. See js/sync.js. */
window.__nine_sync = initSync({ frame, toast: (text, bad) => window.__nine_toast(text, bad) });

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

/* ---------- The song list, checked on its own ----------
   A few seconds after launch and every few hours after that, ask the
   archive what it lists now (catalogue_check, the same read the
   button on Settings makes) and say when something moved: one toast,
   and a dot on the Settings tab until that page is opened. It only
   reports. Nothing is written until Update my list is pressed there,
   and a failure (offline, a damaged listing) is silent: this is a
   courtesy, not something to nag about.

   Opening Settings while the dot is up runs the check again there, so
   what is shown, and what Update my list would write, is fresh. On a
   switch in Settings, `catalogue_auto`, on by default. */

const SONGS_FIRST = 9000;
const SONGS_EVERY = 6 * 60 * 60 * 1000;
const settingsTab = document.querySelector('.side-tab[data-page="settings.html"]');
let songsTold = '';

async function autoCheckSongs() {
  if (!inTauri) return null;
  let s;
  try { s = await invoke('settings_get'); } catch { return null; }
  if (!s || s.catalogue_auto === false) return null;

  let r;
  try { r = await invoke('catalogue_check'); } catch { return null; }
  if (!r || r.unchanged) return null;

  const parts = [];
  if (r.added_total) parts.push(`${r.added_total} new`);
  if (r.edited_total) parts.push(`${r.edited_total} edited`);
  if (r.removed_total) parts.push(`${r.removed_total} no longer listed`);
  const summary = parts.join(', ');

  window.__nine_songs = { at: Date.now(), summary };
  if (settingsTab) settingsTab.classList.add('has-news');

  // Told once per change, not once per check
  const key = `${summary}|${r.live_count}`;
  if (key !== songsTold) {
    songsTold = key;
    window.__nine_toast(`The archive changed: ${summary}. Open Settings to see what.`);
  }
  return summary;
}

/** Settings calls this when it opens: the dot has done its job. */
window.__nine_songs_seen = () => {
  window.__nine_songs = null;
  if (settingsTab) settingsTab.classList.remove('has-news');
};
window.__nine_songs_check = autoCheckSongs;

if (inTauri) {
  setTimeout(autoCheckSongs, SONGS_FIRST);
  setInterval(autoCheckSongs, SONGS_EVERY);
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
  'shell.html', 'js/shell.js', 'js/player.js', 'js/ambient.js', 'js/hotkeys.js', 'js/lyrics.js',
  'js/fx.js', 'js/popover.js', 'js/queue-panel.js', 'js/lab-panel.js', 'js/tray.js', 'js/sync.js',
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
