/* ============================================================
   Settings page.

   Entry point for settings.html. Three things a person can change
   without opening config.toml: which source the player tries first,
   whether Discord is told what is playing, and where the archive is.

   Every change is one settings_set call; Rust writes the file and
   answers with the whole settings block, and the page redraws from
   that, so what is shown is always what the file says. The player is
   told through applySettings(), which under the shell lands on the
   host, so a change takes effect without a reload: the next load()
   reads the new source, and Discord clears at once.

   The defaults are drawn before Rust is asked, and the markup ships
   them too (Local first checked, Discord on), so a backend that cannot
   answer, an old build without the settings commands say, still shows
   a page that reads correctly. It just cannot save, and says so.

   The archive folder is the one thing that cannot apply live. The
   root is resolved once per launch (tauri.js) and the player's audio
   index with it, so the page says so rather than pretending.
   ============================================================ */

import { invoke, inTauri } from './tauri.js';
import { initPlayer, applySettings } from './player.js';

const el = {};
['discord', 'discordWord', 'updates', 'updatesWord', 'versionLine', 'checkUpdates',
  'rootPath', 'rootFound', 'rootBy', 'pickRoot', 'clearRoot',
  'restartNote', 'cfgPath', 'status', 'summary']
  .forEach((id) => { el[id] = document.getElementById(id); });
const sources = [...document.querySelectorAll('input[name="source"]')];
const chip = (k) => el.summary.querySelector(`[data-k="${k}"]`);
const held = (k) => el.rootFound.querySelector(`[data-k="${k}"]`);

/** What the page shows until Rust says otherwise. */
const DEFAULTS = {
  source: 'local',
  discord: true,
  updates: true,
  version: '',
  data_root: { path: '', source: 'not found', exists: false, catalogue: false, covers: false, audio: false, audio_index: false },
  data_root_setting: '',
  config_file: ''
};

let current = null;
let toastTimer = null;

/* ---------- Toast ---------- */

function say(text, bad = false) {
  clearTimeout(toastTimer);
  el.status.textContent = text;
  el.status.dataset.state = bad ? 'bad' : '';
  el.status.classList.add('is-shown');
  toastTimer = setTimeout(() => el.status.classList.remove('is-shown'), bad ? 6000 : 1800);
}

/* ---------- Drawing ---------- */

/** Set a summary chip's text and state, pulsing it if it changed. */
function setChip(k, text, state) {
  const c = chip(k);
  if (!c) return;
  const changed = c.textContent !== text || c.dataset.state !== state;
  c.textContent = text;
  c.dataset.state = state;
  if (changed && current) {
    c.classList.remove('is-changed');
    void c.offsetWidth; // restart the pulse
    c.classList.add('is-changed');
  }
}

function draw(s) {
  sources.forEach((input) => { input.checked = input.value === s.source; });
  setChip('source', s.source === 'stream' ? 'Stream first' : 'Local first', 'on');

  el.discord.checked = s.discord;
  el.discordWord.textContent = s.discord ? el.discordWord.dataset.on : el.discordWord.dataset.off;
  setChip('discord', s.discord ? 'Discord on' : 'Discord off', s.discord ? 'on' : '');

  const updates = s.updates !== false;
  el.updates.checked = updates;
  el.updatesWord.textContent = updates ? el.updatesWord.dataset.on : el.updatesWord.dataset.off;
  el.versionLine.textContent = s.version ? `Version ${s.version}` : 'Version unknown';

  const root = s.data_root;
  ['catalogue', 'covers', 'audio'].forEach((k) => { held(k).dataset.on = String(Boolean(root[k])); });
  if (root.exists) {
    el.rootPath.textContent = root.path;
    el.rootPath.dataset.state = '';
    el.rootBy.textContent = `found by ${root.source}`;
    setChip('root', root.audio ? 'Archive on disk' : 'Song list on disk', 'on');
  } else {
    el.rootPath.textContent = 'No archive folder on this machine';
    el.rootPath.dataset.state = 'none';
    el.rootBy.textContent = 'songs stream, covers load from the archive';
    setChip('root', 'Streaming everything', '');
  }
  el.clearRoot.hidden = !s.data_root_setting;
  el.cfgPath.textContent = s.config_file || 'not available';

  current = s;
}

/* ---------- Writing ---------- */

async function set(key, value) {
  try {
    const next = await invoke('settings_set', { key, value });
    draw(next);
    applySettings({ source: next.source, discord: next.discord });
    say('Saved');
    return true;
  } catch (err) {
    say(`Not saved: ${err}`, true);
    if (current) draw(current);
    return false;
  }
}

function wire() {
  sources.forEach((input) => {
    input.addEventListener('change', () => { if (input.checked) set('source', input.value); });
  });

  el.discord.addEventListener('change', () => set('discord', el.discord.checked));
  el.updates.addEventListener('change', () => set('updates', el.updates.checked));

  // The check lives in the shell, which owns the pop-up. A newer
  // version opens it there; anything else is a line here.
  el.checkUpdates.addEventListener('click', async () => {
    let host = null;
    try { host = window.parent !== window ? window.parent.__nine_updates : null; } catch { host = null; }
    if (!host) { say('Updates are checked by the app window, not this page', true); return; }
    el.checkUpdates.disabled = true;
    say('Checking');
    try {
      const r = await host.check(true);
      if (!r.ok) say(r.error || 'The check failed', true);
      else if (!r.available) say(`You have the latest version, ${r.current}`);
    } finally {
      el.checkUpdates.disabled = false;
    }
  });

  el.pickRoot.addEventListener('click', async () => {
    let picked = null;
    try { picked = await invoke('pick_folder'); } catch (err) { say(String(err), true); return; }
    if (!picked) return;
    if (await set('data_root', picked)) el.restartNote.hidden = false;
  });

  el.clearRoot.addEventListener('click', async () => {
    if (await set('data_root', '')) el.restartNote.hidden = false;
  });
}

async function boot() {
  initPlayer();
  draw(DEFAULTS);
  current = null; // the first real read should not pulse the chips

  if (!inTauri) {
    say('Settings are only available in the desktop app', true);
    return;
  }

  wire();
  try {
    draw(await invoke('settings_get'));
  } catch (err) {
    // An app built before the settings existed: the page shows the
    // defaults and can be looked at, but nothing here can be saved.
    say(`This build of the app cannot save settings (${err}). Rebuild or reinstall it.`, true);
  }
}

boot();
