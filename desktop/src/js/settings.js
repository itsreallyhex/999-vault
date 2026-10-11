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
['discord', 'discordWord', 'updates', 'updatesWord', 'lyrics', 'lyricsWord', 'versionLine', 'checkUpdates',
  'idle', 'idleWord', 'idleSeconds', 'crossfade',
  'catCheck', 'catResult', 'catSum', 'catList', 'catMore', 'catApply', 'catClose',
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
  lyrics: true,
  idle: true,
  idle_seconds: 30,
  crossfade: 0,
  version: '',
  data_root: { path: '', source: 'not found', exists: false, catalogue: false, covers: false, audio: false, audio_index: false },
  data_root_setting: '',
  config_file: ''
};

let current = null;
let toastTimer = null;

/* ---------- Toast ---------- */

function say(text, bad = false) {
  // Under the shell the toast is drawn over the bar, where a page's
  // own would be clipped by the frame. A bare page keeps its own.
  const up = window.parent !== window && window.parent.__nine_toast;
  if (up) { up(text, bad); return; }
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

/** Select the option holding `value`. A value the list does not offer
    (a hand-edited file) is added, so what is shown is what is saved. */
function pick(select, value) {
  const want = String(value);
  let opt = [...select.options].find((o) => o.value === want);
  if (!opt) {
    opt = document.createElement('option');
    opt.value = want;
    opt.textContent = `${want} seconds`;
    select.appendChild(opt);
  }
  select.value = want;
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

  // A binary older than this setting does not send the key: that is on
  const lyrics = s.lyrics !== false;
  el.lyrics.checked = lyrics;
  el.lyricsWord.textContent = lyrics ? el.lyricsWord.dataset.on : el.lyricsWord.dataset.off;

  // A binary older than these settings does not send the keys: the
  // defaults (screen on, 30 seconds, no crossfade) are what it did
  const idle = s.idle !== false;
  el.idle.checked = idle;
  el.idleWord.textContent = idle ? el.idleWord.dataset.on : el.idleWord.dataset.off;
  pick(el.idleSeconds, Number.isFinite(s.idle_seconds) ? s.idle_seconds : 30);
  el.idleSeconds.disabled = !idle;
  pick(el.crossfade, Number.isFinite(s.crossfade) ? s.crossfade : 0);

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
    applySettings({
      source: next.source,
      discord: next.discord,
      idle: next.idle,
      idleSeconds: next.idle_seconds,
      crossfade: next.crossfade
    });
    say('Saved');
    return true;
  } catch (err) {
    say(`Not saved: ${err}`, true);
    if (current) draw(current);
    return false;
  }
}

/* ---------- Song list ----------
   Two steps, both the person's: a check that only reads, and an
   update that writes what the check showed. The shell's Rust holds the
   listing between them, so what is applied is what was on screen. */

const num = (n) => Number(n).toLocaleString('en-US');

function drawCheck(r) {
  el.catResult.hidden = false;
  el.catList.textContent = '';
  el.catMore.hidden = true;

  if (r.unchanged) {
    el.catSum.textContent = `Your list is up to date: ${num(r.saved_count)} songs.`;
    el.catApply.hidden = true;
    el.catClose.textContent = 'Close';
    return;
  }

  const bits = [];
  if (r.added_total) bits.push(`${num(r.added_total)} new`);
  if (r.removed_total) bits.push(`${num(r.removed_total)} no longer listed`);
  if (r.edited_total) bits.push(`${num(r.edited_total)} edited`);
  el.catSum.textContent = `The archive lists ${num(r.live_count)} songs and your list has ${num(r.saved_count)}: ${bits.join(', ')}.`;

  r.added.forEach((s) => {
    const li = document.createElement('li');
    li.textContent = s.category ? `${s.title} (${s.category})` : s.title;
    el.catList.appendChild(li);
  });
  const more = r.added_total - r.added.length;
  const notes = [];
  if (more > 0) notes.push(`and ${num(more)} more new songs`);
  if (r.new_categories.length) {
    notes.push(`New ${r.new_categories.length === 1 ? 'category' : 'categories'}: ${r.new_categories.join(', ')}. It shows under All and gets its own filter.`);
  }
  if (r.removed_total) notes.push('Songs no longer listed leave the list, but any audio you saved stays on disk.');
  el.catMore.textContent = notes.join(' ');
  el.catMore.hidden = notes.length === 0;

  el.catApply.hidden = false;
  el.catApply.disabled = false;
  el.catClose.textContent = 'Not now';
}

async function checkList() {
  el.catCheck.disabled = true;
  say('Asking the archive');
  try {
    drawCheck(await invoke('catalogue_check'));
    say('Checked');
  } catch (err) {
    say(String(err), true);
  } finally {
    el.catCheck.disabled = false;
  }
}

async function applyList() {
  el.catApply.disabled = true;
  try {
    const a = await invoke('catalogue_apply');
    el.catSum.textContent = `Updated: your list now has ${num(a.count)} songs`
      + (a.added ? `, ${num(a.added)} of them new` : '')
      + '. Open the Vault to see them.';
    el.catList.textContent = '';
    el.catMore.hidden = true;
    el.catApply.hidden = true;
    el.catClose.textContent = 'Close';
    say('List updated');
  } catch (err) {
    say(String(err), true);
    el.catApply.disabled = false;
  }
}

function wire() {
  el.catCheck.addEventListener('click', checkList);
  el.catApply.addEventListener('click', applyList);
  el.catClose.addEventListener('click', () => { el.catResult.hidden = true; });

  sources.forEach((input) => {
    input.addEventListener('change', () => { if (input.checked) set('source', input.value); });
  });

  el.discord.addEventListener('change', () => set('discord', el.discord.checked));
  el.updates.addEventListener('change', () => set('updates', el.updates.checked));
  el.lyrics.addEventListener('change', () => set('lyrics', el.lyrics.checked));
  el.idle.addEventListener('change', () => set('idle', el.idle.checked));
  el.idleSeconds.addEventListener('change', () => set('idle_seconds', Number(el.idleSeconds.value)));
  el.crossfade.addEventListener('change', () => set('crossfade', Number(el.crossfade.value)));

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
