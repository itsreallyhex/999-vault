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

   The archive folder is the one thing that cannot apply live. The
   root is resolved once per launch (tauri.js) and the player's audio
   index with it, so the page says so rather than pretending.
   ============================================================ */

import { invoke, inTauri } from './tauri.js';
import { initPlayer, applySettings } from './player.js';

const el = {};
['discord', 'discordWord', 'rootPath', 'rootFound', 'pickRoot', 'clearRoot',
  'restartNote', 'cfgPath', 'status']
  .forEach((id) => { el[id] = document.getElementById(id); });
const sources = [...document.querySelectorAll('input[name="source"]')];

let current = null;

function say(text, bad = false) {
  el.status.textContent = text;
  el.status.dataset.state = bad ? 'bad' : '';
}

/** What the archive folder actually holds, as words. */
function contents(root) {
  const have = [];
  if (root.catalogue) have.push('song list');
  if (root.covers) have.push('covers');
  if (root.audio) have.push('audio');
  return have.length ? have.join(', ') : 'nothing usable';
}

function draw(s) {
  current = s;

  sources.forEach((input) => { input.checked = input.value === s.source; });

  el.discord.checked = s.discord;
  el.discordWord.textContent = s.discord ? 'On' : 'Off';

  const root = s.data_root;
  if (root.exists) {
    el.rootPath.textContent = root.path;
    el.rootFound.textContent = `Holds ${contents(root)}. Found by ${root.source}.`;
  } else {
    el.rootPath.textContent = 'No archive folder';
    el.rootFound.textContent = 'Songs stream from the archive and covers load from it.';
  }
  el.clearRoot.hidden = !s.data_root_setting;
  el.cfgPath.textContent = s.config_file;
}

async function set(key, value) {
  try {
    const next = await invoke('settings_set', { key, value });
    draw(next);
    applySettings({ source: next.source, discord: next.discord });
    say('Saved.');
    return true;
  } catch (err) {
    say(String(err), true);
    if (current) draw(current);
    return false;
  }
}

function wire() {
  sources.forEach((input) => {
    input.addEventListener('change', () => { if (input.checked) set('source', input.value); });
  });

  el.discord.addEventListener('change', () => set('discord', el.discord.checked));

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

  if (!inTauri) {
    say('Settings are only available in the desktop app.', true);
    return;
  }

  wire();
  try {
    draw(await invoke('settings_get'));
  } catch (err) {
    say(`Could not read the settings: ${err}`, true);
  }
}

boot();
