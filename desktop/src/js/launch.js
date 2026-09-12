/* ============================================================
   The start screen.

   Entry point for index.html and nothing else. It draws no covers,
   fetches no archive and imports none of the Vault: the two links do
   the actual work, and this only fills in the figures under them so
   the window has something true on it before either page is opened.

   This is not home.js. That file drew the site's landing page, with
   its mosaic, its strip and its live figures, and it did not come
   across. Nothing here is ported from it.
   ============================================================ */

import { invoke, loadArchive } from './tauri.js';
import { group } from './utils.js';

const status = document.getElementById('status');
const figVault = document.getElementById('figVault');
const figPlaylists = document.getElementById('figPlaylists');

function say(text, state) {
  if (!status) return;
  status.textContent = text;
  if (state) status.dataset.state = state; else delete status.dataset.state;
}

/** How many playlists are saved, read straight out of IndexedDB.
    db.js is not imported for this: opening the database to count rows
    would pull the whole storage module into a screen that otherwise
    touches nothing. */
function countPlaylists() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (n) => { if (!settled) { settled = true; resolve(n); } };

    let request;
    try {
      request = indexedDB.open('999-vault');
    } catch {
      return done(null);
    }

    request.onerror = () => done(null);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('playlists')) {
        db.close();
        return done(0);
      }
      try {
        const tx = db.transaction('playlists', 'readonly');
        const count = tx.objectStore('playlists').count();
        count.onsuccess = () => { done(count.result); db.close(); };
        count.onerror = () => { done(null); db.close(); };
      } catch {
        db.close();
        done(null);
      }
    };
    // A database that does not exist yet is created by this open and is
    // empty, which is the right answer anyway.
    request.onupgradeneeded = () => done(0);
  });
}

async function start() {
  const root = await loadArchive();

  if (!root) {
    say('No archive folder found on this machine. The Vault will ask the '
      + 'live archive instead. Point data_root at it in src-tauri/config.toml.', 'bad');
  } else {
    const bits = [];
    if (!root.covers) bits.push('no covers saved');
    if (!root.audio) bits.push('no audio saved');
    const where = `Archive: ${root.path}`;
    say(bits.length ? `${where} (${bits.join(', ')})` : where);
  }

  // The catalogue is read for one number. It is already on disk and
  // already parsed by Rust, so this costs a command and no network.
  try {
    const snapshot = await invoke('read_catalogue');
    const count = snapshot?.count ?? snapshot?.songs?.length ?? 0;
    if (count) figVault.textContent = `${group(count)} entries`;
  } catch {
    figVault.textContent = 'not saved to this machine';
  }

  const playlists = await countPlaylists();
  if (playlists === null) figPlaylists.textContent = '';
  else if (playlists === 0) figPlaylists.textContent = 'none yet';
  else figPlaylists.textContent = playlists === 1 ? '1 list' : `${group(playlists)} lists`;
}

start();
