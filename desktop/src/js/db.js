/* ============================================================
   Playlist storage.

   The only module that touches IndexedDB, in the same way api.js is
   the only one that touches the network. No DOM, no fetch: it is
   handed plain track objects and returns plain objects back.

   Five stores:

     playlists  { id, name, note, created, updated }
     items      { id, playlistId, pos, added, ...track snapshot }
     recent     { id, at }
     plays      { id, rid, t, c, cov, at, sec }
     syncMeta   { k, v }

   `plays` is the listening history, one row per track started: what
   it was, when, and how many seconds of it were actually heard. The
   overview page on index.html is drawn entirely from this store. It
   is append-only from the player's side and never trimmed.

   `recent` is the player's exclusion queue: the archive record ids
   most recently started, newest last, capped at RECENT_CAP. The
   Vault's random Next picks from outside it, so one session does not
   keep handing back the same handful of tracks. It is keyed by the
   record id, so replaying something refreshes its place rather than
   spending a second slot on it.

   Items carry a copy of the track fields rather than a reference into
   the catalogue. That costs a little space and buys two things: a
   playlist renders through the same buildCover() path as the grid, and
   it still renders when the archive is unreachable.

   `pos` is kept dense, 0..n-1, and rewritten whenever a row is removed
   or moved, so the order never drifts.

   Sync (sync.js) adds three optional fields to playlists, items and
   plays, and `syncMeta` for its bookkeeping:

     dirty    a number, set by every change made here, cleared by sync
              once the server has the row. Rows with no `seq` have
              never been acknowledged and count as unsent as well.
     seq      set by sync when the server has acknowledged the row.
     deleted  a tombstone. Only a row the server has seen is kept as
              one, until the next sync acknowledges the delete. A row
              it has never seen is deleted for real, as before, so a
              machine that never syncs never carries tombstones.
     order    on a playlist, the song titles in the order the server
              last had them.

   Tombstones are hidden from every read in here, and from exportAll.
   The export file stays version 3, so an old file imports and a new
   one opens in an older app.

   Transaction discipline: an IndexedDB transaction closes as soon as
   the event loop turns with no request outstanding. Nothing in here
   awaits between requests. Every multi-step operation chains through
   onsuccess inside one transaction and resolves on its oncomplete, so
   a half-applied write is not possible.
   ============================================================ */

const DB_NAME = '999-vault';
/** 2 added the `recent` store, 3 added `plays`, 4 added `syncMeta`.
    The upgrade only creates what is missing, so a database written by
    an earlier version keeps everything it had. */
const DB_VERSION = 4;
/** The file format of exportAll(). Not the database version: the file
    did not change when the database did. */
const EXPORT_VERSION = 3;

const PLAYLISTS = 'playlists';
const ITEMS = 'items';
const RECENT = 'recent';
const PLAYS = 'plays';
const SYNCMETA = 'syncMeta';

/** How many record ids the exclusion queue holds before the oldest
    falls off and becomes pickable again. */
const RECENT_CAP = 200;

/** Fields copied from a track onto an item. Mirrors api.toTrack().

    `rid` is the archive's own record id, and it is called `rid` rather
    than `id` on purpose: addTrack spreads this snapshot *after* the
    item's `id: uid()`, so a key called `id` here would overwrite every
    item's primary key. It is what the player resolves an audio file
    through. */
const TRACK_KEYS = ['rid', 't', 'a', 'len', 'c', 'sz', 'p', 'd', 'se', 'cov'];

let dbPromise = null;

/** Stable id for a new row. randomUUID is missing on some browsers over
    plain http, which is exactly how this project is served. */
export function uid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A value for `dirty`. Two changes to one row never share one, so
    sync can tell "unchanged since I read it" from "changed again". */
let lastMark = 0;
function mark() {
  const now = Date.now();
  lastMark = now > lastMark ? now : lastMark + 1;
  return lastMark + Math.random() * 0.9;
}

/** Tell the shell's sync that something changed. The pages are separate
    documents, so this is a channel, not a call. Made on first use and
    unref'd, so a script that only imports this module can still exit. */
let channel = null;
function notifySync() {
  try {
    if (!channel && typeof BroadcastChannel === 'function') {
      channel = new BroadcastChannel('999-sync');
      if (typeof channel.unref === 'function') channel.unref();
    }
    if (channel) channel.postMessage('dirty');
  } catch { /* no channel: sync still runs every few minutes */ }
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
        // A removed song that sync still has to report stays here as a
        // tombstone, and adding it again revives that row.
        items.createIndex('byPlaylistTitle', ['playlistId', 't'], { unique: true });
      }

      if (!db.objectStoreNames.contains(RECENT)) {
        const recent = db.createObjectStore(RECENT, { keyPath: 'id' });
        // Ordered by when it was played, which is what makes the
        // oldest-first trim a plain read of the first few keys.
        recent.createIndex('byAt', 'at');
      }

      if (!db.objectStoreNames.contains(PLAYS)) {
        const plays = db.createObjectStore(PLAYS, { keyPath: 'id' });
        plays.createIndex('byAt', 'at');
        plays.createIndex('byRid', 'rid');
      }

      if (!db.objectStoreNames.contains(SYNCMETA)) {
        db.createObjectStore(SYNCMETA, { keyPath: 'k' });
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
 * resolves once the writes have actually landed. A write that touched
 * playlists, items or plays also tells sync.
 */
function run(stores, mode, work) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;

    tx.oncomplete = () => {
      if (mode === 'readwrite' && stores.some((s) => s === PLAYLISTS || s === ITEMS || s === PLAYS)) {
        notifySync();
      }
      resolve(result);
    };
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
  // Null for rows saved before records carried an id. The player falls
  // back to matching those by title, so they still play.
  out.rid = track.rid || null;
  return out;
}

const alive = (row) => !row.deleted;

/** Bump a playlist's `updated` inside an open transaction. With
    `unsent` it is also marked for sync, which only a change to the
    playlist itself (its order) needs: adding or removing a song is an
    item record and leaves the playlist record alone. */
function touch(tx, playlistId, unsent = false) {
  const store = tx.objectStore(PLAYLISTS);
  store.get(playlistId).onsuccess = (event) => {
    const row = event.target.result;
    if (!row) return;
    row.updated = Date.now();
    if (unsent) row.dirty = mark();
    store.put(row);
  };
}

/**
 * Rewrite `pos` to 0..n-1 for one playlist, then touch it.
 * Called after any removal so gaps never accumulate. Tombstones keep
 * -1 and take no place in the order.
 */
function compact(tx, playlistId, done, value) {
  const store = tx.objectStore(ITEMS);
  store.index('byPlaylist').getAll(playlistId).onsuccess = (event) => {
    event.target.result
      .filter(alive)
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

/** Delete an item row, or keep it as a tombstone when the server has
    seen it and has to be told. */
function dropItem(store, row) {
  if (row.seq === undefined) store.delete(row.id);
  else store.put({ ...row, deleted: true, pos: -1, dirty: mark() });
}

/* ---------- Playlists ---------- */

/**
 * Every playlist, most recently changed first, each with its track
 * count. The count comes from one cursor over the index.
 */
export function listPlaylists() {
  return run([PLAYLISTS, ITEMS], 'readonly', (tx, done) => {
    tx.objectStore(PLAYLISTS).getAll().onsuccess = (event) => {
      const rows = event.target.result.filter(alive);
      const counts = new Map();

      const cursor = tx.objectStore(ITEMS).index('byPlaylist').openCursor();
      cursor.onsuccess = (ev) => {
        const c = ev.target.result;
        if (c) {
          if (!c.value.deleted) counts.set(c.key, (counts.get(c.key) || 0) + 1);
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
    updated: now,
    dirty: mark()
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
      if (!row || row.deleted) { done(null); return; }

      if (fields.name !== undefined) {
        const clean = String(fields.name).trim();
        if (clean) row.name = clean.slice(0, 80);
      }
      if (fields.note !== undefined) row.note = String(fields.note).slice(0, 240);

      row.updated = Date.now();
      row.dirty = mark();
      store.put(row);
      done(row);
    };
  });
}

/** Delete a playlist and everything in it, in one transaction. A
    playlist the server has seen stays as a tombstone, with its songs,
    until the next sync reports it. */
export function deletePlaylist(id) {
  return run([PLAYLISTS, ITEMS], 'readwrite', (tx, done) => {
    const items = tx.objectStore(ITEMS);
    const lists = tx.objectStore(PLAYLISTS);

    lists.get(id).onsuccess = (event) => {
      const list = event.target.result;

      items.index('byPlaylist').getAll(id).onsuccess = (ev) => {
        ev.target.result.filter(alive).forEach((row) => dropItem(items, row));
        if (list && list.seq !== undefined) lists.put({ ...list, deleted: true, dirty: mark() });
        else lists.delete(id);
        done(true);
      };
    };
  });
}

/* ---------- Items ---------- */

/** One playlist's tracks, in playlist order. */
export function itemsIn(playlistId) {
  return run([ITEMS], 'readonly', (tx, done) => {
    tx.objectStore(ITEMS).index('byPlaylist').getAll(playlistId).onsuccess = (event) => {
      done(event.target.result.filter(alive).sort((a, b) => a.pos - b.pos));
    };
  });
}

/**
 * Append a track to a playlist.
 * Resolves to the new item, or to null if that title is already in the
 * playlist. A title that was removed and is still waiting to be
 * reported comes back to life on its own row, which keeps the unique
 * index honest.
 */
export function addTrack(playlistId, track) {
  const snap = snapshot(track);

  return run([PLAYLISTS, ITEMS], 'readwrite', (tx, done) => {
    const store = tx.objectStore(ITEMS);

    store.index('byPlaylist').getAll(playlistId).onsuccess = (event) => {
      const rows = event.target.result;
      const have = rows.find((r) => r.t === snap.t);
      if (have && !have.deleted) { done(null); return; }

      const base = have ? { ...have } : { id: uid(), playlistId };
      delete base.deleted;
      const row = {
        ...base,
        pos: rows.filter(alive).length,
        added: Date.now(),
        ...snap,
        dirty: mark()
      };

      const request = store.put(row);
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
      if (!row || row.deleted) { done(false); return; }
      dropItem(store, row);
      compact(tx, row.playlistId, done, true);
    };
  });
}

/** Remove a track from a playlist by title. Used by the picker's toggle. */
export function removeTrack(playlistId, title) {
  return run([PLAYLISTS, ITEMS], 'readwrite', (tx, done) => {
    const store = tx.objectStore(ITEMS);
    store.index('byPlaylistTitle').get([playlistId, title]).onsuccess = (event) => {
      const row = event.target.result;
      if (!row || row.deleted) { done(false); return; }
      dropItem(store, row);
      compact(tx, playlistId, done, true);
    };
  });
}

/**
 * Move an item up or down by `delta` places.
 * Swaps positions with its neighbour, so every other row is untouched.
 * Resolves false at either end of the list. The order lives in the
 * playlist record, so this marks the playlist, not the items.
 */
export function moveItem(playlistId, itemId, delta) {
  return run([PLAYLISTS, ITEMS], 'readwrite', (tx, done) => {
    const store = tx.objectStore(ITEMS);
    store.index('byPlaylist').getAll(playlistId).onsuccess = (event) => {
      const list = event.target.result.filter(alive).sort((a, b) => a.pos - b.pos);

      const from = list.findIndex((r) => r.id === itemId);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= list.length) { done(false); return; }

      const swap = list[from].pos;
      list[from].pos = list[to].pos;
      list[to].pos = swap;

      store.put(list[from]);
      store.put(list[to]);
      touch(tx, playlistId, true);
      done(true);
    };
  });
}

/** Ids of every playlist holding this title. Drives the picker's ticks. */
export function membership(title) {
  return run([ITEMS], 'readonly', (tx, done) => {
    tx.objectStore(ITEMS).index('byTitle').getAll(title).onsuccess = (event) => {
      done(event.target.result.filter(alive).map((r) => r.playlistId));
    };
  });
}

/* ---------- Recently played ---------- */

/**
 * A strictly increasing timestamp.
 *
 * Date.now() alone is not enough: two tracks started inside the same
 * millisecond, which a held-down Next does, get equal `at` values, and
 * an IndexedDB index with equal keys falls back to primary key order.
 * That is alphabetical by record id, so the queue would evict and
 * reorder by id rather than by when things were played. Nudging
 * forward by a millisecond keeps the order honest and stays within a
 * millisecond of the wall clock.
 */
let lastAt = 0;

function stamp() {
  const now = Date.now();
  lastAt = now > lastAt ? now : lastAt + 1;
  return lastAt;
}

/**
 * Record that a track was started, and trim the queue back to cap.
 *
 * Keyed by the record id, so a repeat refreshes that entry's place in
 * the order instead of taking a second slot: the queue holds 200
 * distinct tracks rather than 200 entries, which is what the Vault's
 * random Next actually wants to exclude.
 *
 * The trim reads keys through `byAt`, which hands them back oldest
 * first, and deletes however many are over. Both requests are queued
 * on the same transaction, so the read already sees the write above it.
 */
export function pushRecent(rid, cap = RECENT_CAP) {
  if (!rid) return Promise.resolve(false);

  return run([RECENT], 'readwrite', (tx, done) => {
    const store = tx.objectStore(RECENT);
    store.put({ id: rid, at: stamp() });

    store.index('byAt').getAllKeys().onsuccess = (event) => {
      const keys = event.target.result;
      for (let i = 0; i < keys.length - cap; i++) store.delete(keys[i]);
      done(true);
    };
  });
}

/** Every id in the queue, oldest first. The player mirrors this into a
    Set at boot so a random pick needs no database read. */
export function recentIds() {
  return run([RECENT], 'readonly', (tx, done) => {
    tx.objectStore(RECENT).index('byAt').getAllKeys().onsuccess = (event) => {
      done(event.target.result);
    };
  });
}

/** Empty the queue, so everything is eligible again. */
export function clearRecent() {
  return run([RECENT], 'readwrite', (tx, done) => {
    tx.objectStore(RECENT).clear();
    done(true);
  });
}

/* ---------- Listening history ---------- */

/**
 * Record that a track was started. Resolves to the row's id, which
 * the player hands back to addListened() as the seconds go by.
 *
 * A snapshot of the track rides along, the same fields a playlist row
 * keeps, so the overview can draw a most-played list with covers
 * without reading the catalogue.
 *
 * `start` is when the track began (the player logs a play only once it
 * has been heard for a while) and `sec` is what was heard by then.
 */
export function logPlay(track, { start = 0, sec = 0 } = {}) {
  if (!track) return Promise.resolve(null);

  const row = {
    id: uid(),
    rid: track.rid || null,
    t: track.t || '',
    c: track.c || 'main',
    cov: track.cov || null,
    at: start > 0 ? start : stamp(),
    sec: sec > 0 ? sec : 0,
    dirty: mark()
  };

  return run([PLAYS], 'readwrite', (tx, done) => {
    tx.objectStore(PLAYS).add(row);
    done(row.id);
  });
}

/** Add seconds actually heard to a play. Read and write in one
    transaction, so two flushes cannot lose each other's seconds. */
export function addListened(id, seconds) {
  if (!id || !(seconds > 0)) return Promise.resolve(false);

  return run([PLAYS], 'readwrite', (tx, done) => {
    const store = tx.objectStore(PLAYS);
    store.get(id).onsuccess = (event) => {
      const row = event.target.result;
      if (!row) { done(false); return; }
      row.sec = (row.sec || 0) + seconds;
      row.dirty = mark();
      store.put(row);
      done(true);
    };
  });
}

/** The whole history, oldest first. Small enough to hand over whole:
    one row per play, and the overview wants all of it anyway. */
export function allPlays() {
  return run([PLAYS], 'readonly', (tx, done) => {
    tx.objectStore(PLAYS).index('byAt').getAll().onsuccess = (event) => {
      done(event.target.result);
    };
  });
}

/**
 * Forget the listening history up to now. Resolves to how many plays
 * went. On a machine that has synced, the moment is also kept for the
 * next sync to send, so the other device clears too; on one that never
 * has, nothing is remembered, so a first sync cannot wipe a server's
 * history over something cleared long ago.
 */
export function clearHistory(at = Date.now()) {
  return run([PLAYS, SYNCMETA], 'readwrite', (tx, done) => {
    const plays = tx.objectStore(PLAYS);
    const meta = tx.objectStore(SYNCMETA);

    plays.index('byAt').getAllKeys(IDBKeyRange.upperBound(at)).onsuccess = (event) => {
      const keys = event.target.result;
      keys.forEach((key) => plays.delete(key));

      meta.get('server').onsuccess = (ev) => {
        if (!ev.target.result) { done(keys.length); return; }
        meta.get('clearPending').onsuccess = (e) => {
          const was = e.target.result ? e.target.result.v : 0;
          meta.put({ k: 'clearPending', v: Math.max(was, at) });
          done(keys.length);
        };
      };
    };
  });
}

/* ---------- Backup ---------- */

/**
 * Everything, as one plain object ready for JSON.stringify.
 * IndexedDB lives in one browser profile and clearing site data takes
 * it along with everything else, so an export is the only copy that
 * survives that. Tombstones are left out: they are bookkeeping.
 */
export function exportAll() {
  return run([PLAYLISTS, ITEMS, PLAYS], 'readonly', (tx, done) => {
    tx.objectStore(PLAYLISTS).getAll().onsuccess = (event) => {
      const playlists = event.target.result.filter(alive);

      tx.objectStore(ITEMS).getAll().onsuccess = (ev) => {
        const byList = new Map();
        ev.target.result.filter(alive).forEach((item) => {
          if (!byList.has(item.playlistId)) byList.set(item.playlistId, []);
          byList.get(item.playlistId).push(item);
        });

        // The history goes along with the lists: it is the other thing
        // clearing site data would take, and the only copy of it.
        tx.objectStore(PLAYS).getAll().onsuccess = (e) => {
          done({
            app: DB_NAME,
            version: EXPORT_VERSION,
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
              })),
            plays: e.target.result
              .map(({ id, rid, t, c, cov, at, sec }) => ({ id, rid, t, c, cov, at, sec }))
              .sort((a, b) => a.at - b.at)
          });
        };
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

  // Older exports carry no history. Rows keep their ids and go in with
  // put, so importing the same file twice does not double the plays.
  const plays = Array.isArray(payload.plays) ? payload.plays : [];

  return run([PLAYLISTS, ITEMS, PLAYS], 'readwrite', (tx, done) => {
    const lists = tx.objectStore(PLAYLISTS);
    const items = tx.objectStore(ITEMS);
    const history = tx.objectStore(PLAYS);
    let addedPlays = 0;

    plays.forEach((row) => {
      if (!row || !row.id || !Number.isFinite(Number(row.at))) return;
      history.put({
        id: String(row.id),
        rid: row.rid || null,
        t: String(row.t || ''),
        c: String(row.c || 'main'),
        cov: row.cov || null,
        at: Number(row.at),
        sec: Number(row.sec) || 0,
        dirty: mark()
      });
      addedPlays++;
    });

    lists.getAll().onsuccess = (event) => {
      const taken = new Set(event.target.result.filter(alive).map((p) => p.name));
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
          updated: now,
          dirty: mark()
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
            ...snapshot(row),
            dirty: mark()
          });
          addedItems++;
        });
      });

      done({ playlists: addedLists, items: addedItems, plays: addedPlays });
    };
  });
}

/* ---------- For sync.js ---------- */

/*
   Raw access, and nothing else. What to send and how to merge an answer
   is sync.js's business; this module only reads every row and applies
   a list of writes inside one transaction, so what sync decided is
   what is stored, even with another page writing at the same moment.
   These writes do not wake sync again.
*/

const SYNC_STORES = [PLAYLISTS, ITEMS, PLAYS, SYNCMETA];

/** Every row of the three data stores, and the bookkeeping as an object. */
function readState(tx, then) {
  const state = {};
  tx.objectStore(PLAYLISTS).getAll().onsuccess = (a) => {
    state.playlists = a.target.result;
    tx.objectStore(ITEMS).getAll().onsuccess = (b) => {
      state.items = b.target.result;
      tx.objectStore(PLAYS).getAll().onsuccess = (c) => {
        state.plays = c.target.result;
        tx.objectStore(SYNCMETA).getAll().onsuccess = (d) => {
          state.meta = {};
          d.target.result.forEach((row) => { state.meta[row.k] = row.v; });
          then(state);
        };
      };
    };
  };
}

export function syncRead() {
  return run(SYNC_STORES, 'readonly', (tx, done) => readState(tx, done));
}

/**
 * Read everything, hand it to `decide`, and apply what it returns, all
 * in one transaction. `decide(state)` is synchronous and returns
 *
 *   { put: { playlists, items, plays }, remove: { playlists, items, plays },
 *     meta: { key: value | undefined }, result }
 *
 * `remove` holds primary keys and runs before `put`. A meta value of
 * undefined deletes the key. Resolves to `result`.
 */
export function syncTransact(decide) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(SYNC_STORES, 'readwrite');
    let result;

    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('sync transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('sync transaction aborted'));

    readState(tx, (state) => {
      let ops;
      try {
        ops = decide(state) || {};
      } catch (err) {
        tx.abort();
        reject(err);
        return;
      }

      const stores = { playlists: PLAYLISTS, items: ITEMS, plays: PLAYS };
      Object.entries(stores).forEach(([name, store]) => {
        const target = tx.objectStore(store);
        ((ops.remove && ops.remove[name]) || []).forEach((key) => target.delete(key));
        ((ops.put && ops.put[name]) || []).forEach((row) => target.put(row));
      });

      const meta = tx.objectStore(SYNCMETA);
      Object.entries(ops.meta || {}).forEach(([k, v]) => {
        if (v === undefined) meta.delete(k);
        else meta.put({ k, v });
      });

      result = ops.result;
    });
  }));
}
