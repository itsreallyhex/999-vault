/* ============================================================
   Playlist storage.

   The only module that touches IndexedDB, in the same way api.js is
   the only one that touches the network. No DOM, no fetch: it is
   handed plain track objects and returns plain objects back.

   Two stores:

     playlists  { id, name, note, created, updated }
     items      { id, playlistId, pos, added, ...track snapshot }

   Items carry a copy of the track fields rather than a reference into
   the catalogue. That costs a little space and buys two things: a
   playlist renders through the same buildCover() path as the grid, and
   it still renders when the archive is unreachable.

   `pos` is kept dense, 0..n-1, and rewritten whenever a row is removed
   or moved, so the order never drifts.

   Transaction discipline: an IndexedDB transaction closes as soon as
   the event loop turns with no request outstanding. Nothing in here
   awaits between requests. Every multi-step operation chains through
   onsuccess inside one transaction and resolves on its oncomplete, so
   a half-applied write is not possible.
   ============================================================ */

const DB_NAME = '999-vault';
const DB_VERSION = 1;

const PLAYLISTS = 'playlists';
const ITEMS = 'items';

/** Fields copied from a track onto an item. Mirrors api.toTrack(). */
const TRACK_KEYS = ['t', 'a', 'len', 'c', 'sz', 'p', 'd', 'se', 'cov'];

let dbPromise = null;

/** Stable id for a new row. randomUUID is missing on some browsers over
    plain http, which is exactly how this project is served. */
function uid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Open the database, once.
 * A failed open is not cached, so a later call can retry: the usual
 * cause is a private window, where IndexedDB can be refused outright.
 */
export function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('This browser has no IndexedDB available'));
      return;
    }

    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(PLAYLISTS)) {
        db.createObjectStore(PLAYLISTS, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(ITEMS)) {
        const items = db.createObjectStore(ITEMS, { keyPath: 'id' });
        items.createIndex('byPlaylist', 'playlistId');
        items.createIndex('byTitle', 't');
        // Unique, so the same title cannot land in one playlist twice.
        // The repeat surfaces as a ConstraintError, caught in addTrack().
        items.createIndex('byPlaylistTitle', ['playlistId', 't'], { unique: true });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('could not open the database'));
    request.onblocked = () => reject(new Error('another tab is holding an older version of the database'));
  });

  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

/**
 * Run one transaction.
 * `work` is handed the transaction and a `done` callback recording the
 * value to resolve with. The promise settles on oncomplete, so it only
 * resolves once the writes have actually landed.
 */
function run(stores, mode, work) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;

    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));

    try {
      work(tx, (value) => { result = value; });
    } catch (err) {
      tx.abort();
      reject(err);
    }
  }));
}

/** Copy just the track fields an item stores. */
function snapshot(track) {
  const out = {};
  TRACK_KEYS.forEach((k) => { out[k] = track[k]; });
  out.a = Array.isArray(track.a) ? track.a.slice() : [];
  out.len = track.len || '';
  out.c = track.c || 'main';
  out.sz = track.sz || '';
  out.d = track.d || '';
  out.se = Boolean(track.se);
  out.p = track.p || 0;
  out.cov = track.cov || null;
  return out;
}

/** Bump a playlist's `updated` inside an open transaction. */
function touch(tx, playlistId) {
  const store = tx.objectStore(PLAYLISTS);
  store.get(playlistId).onsuccess = (event) => {
    const row = event.target.result;
    if (!row) return;
    row.updated = Date.now();
    store.put(row);
  };
}

/**
 * Rewrite `pos` to 0..n-1 for one playlist, then touch it.
 * Called after any removal so gaps never accumulate.
 */
function compact(tx, playlistId, done, value) {
  const store = tx.objectStore(ITEMS);
  store.index('byPlaylist').getAll(playlistId).onsuccess = (event) => {
    event.target.result
      .sort((a, b) => a.pos - b.pos)
      .forEach((row, i) => {
        if (row.pos !== i) {
          row.pos = i;
          store.put(row);
        }
      });
    touch(tx, playlistId);
    done(value);
  };
}

/* ---------- Playlists ---------- */

/**
 * Every playlist, most recently changed first, each with its track
 * count. The count comes from one key cursor over the index rather
 * than reading the items themselves.
 */
export function listPlaylists() {
  return run([PLAYLISTS, ITEMS], 'readonly', (tx, done) => {
    tx.objectStore(PLAYLISTS).getAll().onsuccess = (event) => {
      const rows = event.target.result;
      const counts = new Map();

      const cursor = tx.objectStore(ITEMS).index('byPlaylist').openKeyCursor();
      cursor.onsuccess = (ev) => {
        const c = ev.target.result;
        if (c) {
          counts.set(c.key, (counts.get(c.key) || 0) + 1);
          c.continue();
          return;
        }
        done(rows
          .map((p) => ({ ...p, n: counts.get(p.id) || 0 }))
          .sort((a, b) => b.updated - a.updated));
      };
    };
  });
}

/** Create a playlist. Resolves to the new row. */
export function createPlaylist(name, note = '') {
  const clean = String(name || '').trim();
  if (!clean) return Promise.reject(new Error('A playlist needs a name'));

  const now = Date.now();
  const row = {
    id: uid(),
    name: clean.slice(0, 80),
    note: String(note).slice(0, 240),
    created: now,
    updated: now
  };

  return run([PLAYLISTS], 'readwrite', (tx, done) => {
    tx.objectStore(PLAYLISTS).add(row);
    done({ ...row, n: 0 });
  });
}

/** Change a playlist's name or note. Resolves to the row, or null if gone. */
export function updatePlaylist(id, fields) {
  return run([PLAYLISTS], 'readwrite', (tx, done) => {
    const store = tx.objectStore(PLAYLISTS);
    store.get(id).onsuccess = (event) => {
      const row = event.target.result;
      if (!row) { done(null); return; }

      if (fields.name !== undefined) {
        const clean = String(fields.name).trim();
        if (clean) row.name = clean.slice(0, 80);
      }
      if (fields.note !== undefined) row.note = String(fields.note).slice(0, 240);

      row.updated = Date.now();
      store.put(row);
      done(row);
    };
  });
}

/** Delete a playlist and everything in it, in one transaction. */
export function deletePlaylist(id) {
  return run([PLAYLISTS, ITEMS], 'readwrite', (tx, done) => {
    const items = tx.objectStore(ITEMS);
    items.index('byPlaylist').getAllKeys(id).onsuccess = (event) => {
      event.target.result.forEach((key) => items.delete(key));
      tx.objectStore(PLAYLISTS).delete(id);
      done(true);
    };
  });
}

/* ---------- Items ---------- */

/** One playlist's tracks, in playlist order. */
export function itemsIn(playlistId) {
  return run([ITEMS], 'readonly', (tx, done) => {
    tx.objectStore(ITEMS).index('byPlaylist').getAll(playlistId).onsuccess = (event) => {
      done(event.target.result.sort((a, b) => a.pos - b.pos));
    };
  });
}

/**
 * Append a track to a playlist.
 * Resolves to the new item, or to null if that title is already in the
 * playlist. The unique compound index is what detects the repeat;
 * preventDefault on the error stops it aborting the transaction.
 */
export function addTrack(playlistId, track) {
  return run([PLAYLISTS, ITEMS], 'readwrite', (tx, done) => {
    const store = tx.objectStore(ITEMS);

    store.index('byPlaylist').count(playlistId).onsuccess = (event) => {
      const row = {
        id: uid(),
        playlistId,
        pos: event.target.result,
        added: Date.now(),
        ...snapshot(track)
      };

      const request = store.add(row);
      request.onsuccess = () => {
        touch(tx, playlistId);
        done(row);
      };
      request.onerror = (ev) => {
        if (request.error && request.error.name === 'ConstraintError') {
          ev.preventDefault();
          ev.stopPropagation();
          done(null);
        }
      };
    };
  });
}

/** Remove one item by its own id. Resolves false if it was already gone. */
export function removeItem(id) {
  return run([PLAYLISTS, ITEMS], 'readwrite', (tx, done) => {
    const store = tx.objectStore(ITEMS);
    store.get(id).onsuccess = (event) => {
      const row = event.target.result;
      if (!row) { done(false); return; }
      store.delete(id).onsuccess = () => compact(tx, row.playlistId, done, true);
    };
  });
}

/** Remove a track from a playlist by title. Used by the picker's toggle. */
export function removeTrack(playlistId, title) {
  return run([PLAYLISTS, ITEMS], 'readwrite', (tx, done) => {
    const store = tx.objectStore(ITEMS);
    store.index('byPlaylistTitle').getKey([playlistId, title]).onsuccess = (event) => {
      const key = event.target.result;
      if (key === undefined) { done(false); return; }
      store.delete(key).onsuccess = () => compact(tx, playlistId, done, true);
    };
  });
}

/**
 * Move an item up or down by `delta` places.
 * Swaps positions with its neighbour, so every other row is untouched.
 * Resolves false at either end of the list.
 */
export function moveItem(playlistId, itemId, delta) {
  return run([PLAYLISTS, ITEMS], 'readwrite', (tx, done) => {
    const store = tx.objectStore(ITEMS);
    store.index('byPlaylist').getAll(playlistId).onsuccess = (event) => {
      const list = event.target.result.sort((a, b) => a.pos - b.pos);

      const from = list.findIndex((r) => r.id === itemId);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= list.length) { done(false); return; }

      const swap = list[from].pos;
      list[from].pos = list[to].pos;
      list[to].pos = swap;

      store.put(list[from]);
      store.put(list[to]);
      touch(tx, playlistId);
      done(true);
    };
  });
}

/** Ids of every playlist holding this title. Drives the picker's ticks. */
export function membership(title) {
  return run([ITEMS], 'readonly', (tx, done) => {
    tx.objectStore(ITEMS).index('byTitle').getAll(title).onsuccess = (event) => {
      done(event.target.result.map((r) => r.playlistId));
    };
  });
}

/* ---------- Backup ---------- */

/**
 * Everything, as one plain object ready for JSON.stringify.
 * IndexedDB lives in one browser profile and clearing site data takes
 * it along with everything else, so an export is the only copy that
 * survives that.
 */
export function exportAll() {
  return run([PLAYLISTS, ITEMS], 'readonly', (tx, done) => {
    tx.objectStore(PLAYLISTS).getAll().onsuccess = (event) => {
      const playlists = event.target.result;

      tx.objectStore(ITEMS).getAll().onsuccess = (ev) => {
        const byList = new Map();
        ev.target.result.forEach((item) => {
          if (!byList.has(item.playlistId)) byList.set(item.playlistId, []);
          byList.get(item.playlistId).push(item);
        });

        done({
          app: DB_NAME,
          version: DB_VERSION,
          exported: new Date().toISOString(),
          playlists: playlists
            .sort((a, b) => a.created - b.created)
            .map((p) => ({
              name: p.name,
              note: p.note || '',
              created: p.created,
              items: (byList.get(p.id) || [])
                .sort((a, b) => a.pos - b.pos)
                .map((item) => ({ added: item.added, ...snapshot(item) }))
            }))
        });
      };
    };
  });
}

/**
 * Read an exported file back in.
 * Always creates new playlists rather than overwriting: a name already
 * taken gets a suffix, so importing the same file twice loses nothing.
 * Resolves to a count of what was added.
 */
export function importAll(payload) {
  const incoming = payload && Array.isArray(payload.playlists) ? payload.playlists : null;
  if (!incoming) return Promise.reject(new Error('That file is not a 999 playlist export'));

  return run([PLAYLISTS, ITEMS], 'readwrite', (tx, done) => {
    const lists = tx.objectStore(PLAYLISTS);
    const items = tx.objectStore(ITEMS);

    lists.getAll().onsuccess = (event) => {
      const taken = new Set(event.target.result.map((p) => p.name));
      let addedLists = 0;
      let addedItems = 0;

      incoming.forEach((source) => {
        const base = String(source.name || '').trim().slice(0, 80) || 'Imported playlist';
        let name = base;
        let n = 2;
        while (taken.has(name)) name = `${base} (imported ${n++})`;
        taken.add(name);

        const now = Date.now();
        const id = uid();
        lists.add({
          id,
          name,
          note: String(source.note || '').slice(0, 240),
          created: Number(source.created) || now,
          updated: now
        });
        addedLists++;

        const rows = Array.isArray(source.items) ? source.items : [];
        const seen = new Set();
        rows.forEach((row) => {
          const title = row && row.t;
          // The unique index would abort the whole import on a repeat,
          // so duplicates inside one incoming list are dropped here.
          if (!title || seen.has(title)) return;
          seen.add(title);

          items.add({
            id: uid(),
            playlistId: id,
            pos: seen.size - 1,
            added: Number(row.added) || now,
            ...snapshot(row)
          });
          addedItems++;
        });
      });

      done({ playlists: addedLists, items: addedItems });
    };
  });
}
