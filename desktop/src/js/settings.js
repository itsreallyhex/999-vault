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
import { clearHistory } from './db.js';

const el = {};
['discord', 'discordWord', 'updates', 'updatesWord', 'lyrics', 'lyricsWord', 'versionLine', 'checkUpdates',
  'idle', 'idleWord', 'idleSeconds', 'crossfade',
  'syncUrl', 'syncToken', 'syncSave', 'syncNow', 'syncStop', 'syncStatus', 'clearHistory',
  'catCheck', 'catResult', 'catSum', 'catList', 'catMore', 'catApply', 'catClose', 'catAuto', 'catAutoWord',
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
  catalogue_auto: true,
  sync_url: '',
  sync_token_set: false,
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

  // Older binaries do not send it: the check on its own is what they did not have, so on
  const auto = s.catalogue_auto !== false;
  el.catAuto.checked = auto;
  el.catAutoWord.textContent = auto ? el.catAutoWord.dataset.on : el.catAutoWord.dataset.off;

  // Sync: the address is shown, the token never is. Only whether one is saved.
  const url = s.sync_url || '';
  if (document.activeElement !== el.syncUrl) el.syncUrl.value = url;
  el.syncToken.placeholder = s.sync_token_set ? 'Saved. Paste a new one to replace it' : 'Paste the token';
  const syncSet = Boolean(url) && Boolean(s.sync_token_set);
  el.syncNow.disabled = !syncSet;
  el.syncStop.disabled = !url && !s.sync_token_set;

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

/** A song as the lists show it: "Title (category)", with a second line
    under it when there is something to say about it. */
function songRow(title, category, sub) {
  const li = document.createElement('li');
  li.textContent = category ? `${title} (${category})` : title;
  if (sub) {
    const s = document.createElement('span');
    s.className = 'cat-sub';
    s.textContent = sub;
    li.appendChild(s);
  }
  return li;
}

/** A heading and its rows, or nothing when there are none. */
function section(title, rows) {
  if (!rows.length) return;
  const head = document.createElement('li');
  head.className = 'cat-head';
  head.textContent = title;
  el.catList.appendChild(head);
  rows.forEach((row) => el.catList.appendChild(row));
}

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

  // Every one that moved, in three groups. A binary older than the
  // edited list sends none, and the count in the line above stands.
  const edited = r.edited || [];
  section(`New (${num(r.added_total)})`, r.added.map((s) => songRow(s.title, s.category)));
  section(`Edited (${num(r.edited_total)})`, edited.map((e) => {
    const said = [];
    if (e.was) said.push(`was ${e.was}`);
    if (e.changes && e.changes.length) said.push(`changed: ${e.changes.join(', ')}`);
    return songRow(e.title, e.category, said.join('. '));
  }));
  section(`No longer listed (${num(r.removed_total)})`, r.removed.map((s) => songRow(s.title, s.category)));

  const notes = [];
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

/* ---------- Sync ----------
   The sync itself runs in the shell (js/sync.js). This card saves the
   address and the token, asks the shell to sync, and shows what it
   says. The token goes to Rust and is never read back. */

function syncHost() {
  try { return window.parent !== window ? window.parent.__nine_sync || null : null; } catch { return null; }
}

function drawSync(s) {
  const bits = [s.message];
  if (s.state === 'idle') {
    const when = s.at ? new Date(s.at).toLocaleTimeString() : '';
    bits[0] = `Synced${when ? ` at ${when}` : ''}`;
    bits.push(`sent ${num(s.pushed)}, received ${num(s.pulled)}`);
    if (s.rejected) bits.push(`${num(s.rejected)} of yours replaced by the newer version`);
  }
  el.syncStatus.textContent = bits.join('. ');
  el.syncStatus.dataset.state = s.state === 'error' ? 'error' : '';
  el.syncNow.disabled = s.state === 'running' || s.state === 'off';
}

async function saveSync() {
  const url = el.syncUrl.value.trim();
  const token = el.syncToken.value.trim();
  el.syncSave.disabled = true;
  try {
    if (!(await set('sync_url', url))) return;
    if (token && !(await set('sync_token', token))) return;
    el.syncToken.value = '';
    const host = syncHost();
    if (host) await host.refresh();
  } finally {
    el.syncSave.disabled = false;
  }
}

async function syncNow() {
  const host = syncHost();
  if (!host) { say('Sync is run by the app window, not this page', true); return; }
  el.syncNow.disabled = true;
  try { await host.now(); } finally { drawSync(host.status()); }
}

async function stopSync() {
  const host = syncHost();
  if (!host) { say('Sync is run by the app window, not this page', true); return; }
  el.syncStop.disabled = true;
  try {
    await host.stop();
    el.syncToken.value = '';
    draw(await invoke('settings_get'));
    say('Sync is off');
  } catch (err) {
    say(`Could not stop sync: ${err}`, true);
  }
}

let clearArmed = null;
async function clearPlays() {
  if (!clearArmed) {
    // Two presses, because it cannot be taken back.
    el.clearHistory.textContent = 'Press again to clear';
    clearArmed = setTimeout(() => {
      clearArmed = null;
      el.clearHistory.textContent = 'Clear history';
    }, 4000);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = null;
  el.clearHistory.textContent = 'Clear history';
  try {
    const n = await clearHistory();
    say(n ? `Listening history cleared (${num(n)} plays)` : 'There was no history to clear');
  } catch (err) {
    say(`Not cleared: ${err}`, true);
  }
}

function wire() {
  el.syncSave.addEventListener('click', saveSync);
  el.syncNow.addEventListener('click', syncNow);
  el.syncStop.addEventListener('click', stopSync);
  el.clearHistory.addEventListener('click', clearPlays);

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
  el.catAuto.addEventListener('change', () => set('catalogue_auto', el.catAuto.checked));

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

  // The sync line follows the shell's, and is re-read now so a first
  // sync that is waiting says so.
  const host = syncHost();
  if (host) {
    drawSync(host.status());
    const stop = host.subscribe(drawSync);
    window.addEventListener('pagehide', stop, { once: true });
    host.refresh();
  }

  // The shell found changes on its own and put a dot on this tab: show
  // them without a press. Asked again here, so what is on screen is what
  // Update my list would write.
  let news = null;
  try { news = window.parent !== window ? window.parent.__nine_songs : null; } catch { news = null; }
  if (news) {
    try { window.parent.__nine_songs_seen(); } catch { /* not under the shell */ }
    checkList();
  }
}

boot();
