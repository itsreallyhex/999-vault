/* ============================================================
   Sync with the owner's own server.

   Playlists, the songs in them, their order, and the listening
   history, kept level with the iPhone app through a small server the
   owner runs. The protocol is 999 sync protocol v1 (PROTOCOL.md in the
   999-vault-sync repo); this file is the desktop's side of it and the
   only place that knows it.

   Two halves, on purpose:

     the rules     pure functions over plain rows, no DOM, no
                   IndexedDB, no network. effectiveOrder, buildPush,
                   mergeResponse, resetOps. desktop/sync.test.js runs
                   them under node.

     the runner    initSync(): reads and writes through db.js, sends
                   through the one Rust command, owns the triggers,
                   the backoff and the status line. Shell only: the
                   pages reach it as window.parent.__nine_sync.

   The server is only ever asked from Rust (`sync_request` in
   sync.rs), which also holds the token, so this file never sees it.

   What a row carries (see db.js): `dirty` while there is a change the
   server has not acknowledged, `seq` once it has seen the row, and
   `deleted` for a tombstone that has not been acknowledged yet. A row
   with no `seq` has never reached the server and is sent as well.

   A failed sync changes nothing: every local write happens in one
   transaction after a good answer, so offline, a 5xx and a timeout
   leave the rows and their dirty marks exactly as they were.
   ============================================================ */

import { invoke, inTauri } from './tauri.js';
import { exportAll, syncRead, syncTransact, uid } from './db.js';

export const DEVICE = 'desktop';

const SEP = '\u0000';
/** Records per request. A first push of a long history is several. Small
    on purpose: a free Cloudflare Worker gets 10 ms of CPU a request. */
const CHUNK = 250;
const DEBOUNCE = 5000;
/** A change is sent within this long even if more keep arriving: the
    player writes the seconds heard every few seconds while a song plays.
    Long on purpose: the server is billed by the minute it is awake, and
    a half-listened song can wait a few minutes to reach the phone. */
const MAX_WAIT = 3 * 60 * 1000;
/** The idle poll. The server sleeps after 5 to 10 quiet minutes, so
    anything shorter than that keeps it awake all day. */
const EVERY = 30 * 60 * 1000;
/** Coming back to the window syncs only if this long has passed. */
const VISIBLE_GAP = 10 * 60 * 1000;
/** A server that was asleep answers its first request with a 502 or
    503 while it wakes. Wait, then ask again. */
const WAKE_WAITS = [3000, 6000];
const FIRST_AFTER = 6000;
const BACKOFF_START = 30000;
const BACKOFF_MAX = 10 * 60 * 1000;

/* ============================================================
   The rules
   ============================================================ */

export const itemKey = (playlistId, t) => `${playlistId}${SEP}${t}`;

/** What the server has not got: changed since, or never acknowledged. */
const unsent = (row) => Boolean(row.dirty) || row.seq === undefined;
const alive = (row) => !row.deleted;
/** A title is the identity of a song and the server holds 300 characters
    of it. A longer one stays on this machine rather than spoil a push. */
const syncable = (item) => typeof item.t === 'string' && item.t.length > 0 && item.t.length <= 300;
const nameKey = (name) => String(name || '').trim().toLowerCase();
const whole = (n) => Math.max(0, Math.floor(Number(n) || 0));
const cut = (s, n) => String(s === null || s === undefined ? '' : s).slice(0, n);
const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const byAddedThenTitle = (a, b) => (a.added || 0) - (b.added || 0) || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0);

/**
 * The order of a playlist as the protocol defines it: the titles in the
 * playlist's `order` that are alive, then the live songs it does not
 * list, by when they were added. `items` are the live songs.
 */
export function effectiveOrder(order, items) {
  const have = new Set(items.map((i) => i.t));
  const seen = new Set();
  const out = [];
  (order || []).forEach((t) => {
    if (have.has(t) && !seen.has(t)) { seen.add(t); out.push(t); }
  });
  items.filter((i) => !seen.has(i.t)).sort(byAddedThenTitle).forEach((i) => out.push(i.t));
  return out;
}

function liveByList(items) {
  const map = new Map();
  items.forEach((i) => {
    if (i.deleted || !syncable(i)) return;
    if (!map.has(i.playlistId)) map.set(i.playlistId, []);
    map.get(i.playlistId).push(i);
  });
  return map;
}

function listRecord(p, order) {
  return {
    kind: 'playlist',
    id: p.id,
    name: cut(p.name, 80) || 'Untitled',
    note: cut(p.note, 240),
    created: whole(p.created),
    updated: whole(p.updated),
    deleted: Boolean(p.deleted),
    order
  };
}

function itemRecord(i) {
  return {
    kind: 'item',
    playlistId: i.playlistId,
    t: i.t,
    added: whole(i.added),
    rid: i.rid ? cut(i.rid, 64) : null,
    a: (Array.isArray(i.a) ? i.a : []).slice(0, 50).map((s) => cut(s, 200)),
    len: cut(i.len, 40),
    c: cut(i.c || 'main', 40),
    sz: cut(i.sz, 40),
    p: Math.max(0, Number(i.p) || 0),
    d: cut(i.d, 80),
    se: Boolean(i.se),
    cov: i.cov ? cut(i.cov, 1000) : null,
    updated: whole(i.updated || i.added),
    deleted: Boolean(i.deleted)
  };
}

function playRecord(l) {
  return {
    kind: 'play',
    id: l.id,
    rid: l.rid ? cut(l.rid, 64) : null,
    t: cut(l.t, 300),
    c: cut(l.c || 'main', 40),
    cov: l.cov ? cut(l.cov, 1000) : null,
    at: whole(l.at),
    sec: Math.max(0, Number(l.sec) || 0)
  };
}

/**
 * Everything the server should be sent, from a snapshot of the rows.
 * Resolves to `records` in the order the server wants them (playlists,
 * then items, then plays) and `stamps`: the `dirty` value each row had,
 * so the answer can clear a mark only on a row that has not changed
 * since.
 *
 * A playlist record also goes when the order the server would work out
 * from its last known `order` is not the order held here: a move, or a
 * song removed and added again. Adding or removing a song on its own
 * never rewrites it.
 */
export function buildPush(state) {
  const byList = liveByList(state.items);
  const records = [];
  const stamps = new Map();

  state.playlists.forEach((p) => {
    const items = byList.get(p.id) || [];
    const local = items.slice().sort((a, b) => a.pos - b.pos).map((i) => i.t);
    let send = unsent(p);
    if (!send && !p.deleted) send = !sameList(effectiveOrder(p.order, items), local);
    if (!send) return;
    records.push(listRecord(p, p.deleted ? [] : local));
    stamps.set(`playlist|${p.id}`, p.dirty || 0);
  });

  state.items.forEach((i) => {
    if (!unsent(i) || !syncable(i)) return;
    records.push(itemRecord(i));
    stamps.set(`item|${itemKey(i.playlistId, i.t)}`, i.dirty || 0);
  });

  state.plays.forEach((l) => {
    if (!unsent(l)) return;
    records.push(playRecord(l));
    stamps.set(`play|${l.id}`, l.dirty || 0);
  });

  return { records, stamps };
}

/**
 * What to write after the server answered, as a list of operations for
 * db.syncTransact. Pure: `state` is every row and the bookkeeping at the
 * moment of writing, `resp` is the server's reply, and nothing in either
 * is changed.
 *
 *   ctx.sent       the records this request pushed
 *   ctx.stamps     buildPush's stamps for them
 *   ctx.sentClear  the clearHistoryAt that went with it
 *   ctx.server     the server address, set on the first sync only
 *   ctx.first      true for the pull that opens a first sync: local
 *                  playlists are matched to the server's by name
 *
 * Rules, in the order they are applied:
 *   - a change to a row that is dirty here is skipped, because the push
 *     of that row settles it; a key the server rejected is the
 *     exception, it is always taken and its dirty mark dropped
 *   - a tombstone never removes a song that has not gone up yet
 *   - a play keeps the larger `sec`
 *   - what was pushed and not rejected is acknowledged, a tombstone that
 *     was acknowledged is deleted for real
 *   - plays at or before historyClearedAt go
 *   - `pos` is worked out again for every playlist that changed
 */
export function mergeResponse(state, resp, ctx = {}) {
  const now = ctx.now === undefined ? Date.now() : ctx.now;
  const newId = ctx.newId || uid;
  const P = new Map(state.playlists.map((r) => [r.id, { ...r }]));
  const I = new Map(state.items.map((r) => [itemKey(r.playlistId, r.t), { ...r }]));
  const L = new Map(state.plays.map((r) => [r.id, { ...r }]));
  const putP = new Set();
  const putI = new Set();
  const putL = new Set();
  const goneP = new Set();
  const goneI = new Set();
  const goneL = new Set();
  const reorder = new Set();
  const meta = state.meta || {};
  const rejected = new Set((resp.rejected || []).map((r) => `${r.kind}|${r.key}`));
  const cleared = Math.max(meta.historyClearedAt || 0, resp.historyClearedAt || 0);
  let applied = 0;

  const dropItem = (key) => {
    const row = I.get(key);
    if (!row) return;
    I.delete(key);
    putI.delete(key);
    goneI.add(row.id);
    reorder.add(row.playlistId);
  };
  const dropList = (id) => {
    if (P.has(id)) { P.delete(id); putP.delete(id); goneP.add(id); }
    [...I].forEach(([key, row]) => { if (row.playlistId === id) dropItem(key); });
  };

  /* First sync: a local playlist whose name matches one on the server
     takes the server's id, and its songs merge by title. */
  if (ctx.first) {
    const theirs = (resp.changes || [])
      .filter((c) => c.kind === 'playlist' && !c.deleted)
      .sort((a, b) => (a.created - b.created) || (a.id < b.id ? -1 : 1));
    const named = new Map();
    theirs.forEach((s) => { if (!named.has(nameKey(s.name))) named.set(nameKey(s.name), s); });

    const taken = new Set();
    [...P.values()].filter(alive).sort((a, b) => (a.created || 0) - (b.created || 0)).forEach((p) => {
      const s = named.get(nameKey(p.name));
      if (!s || taken.has(s.id)) return;
      taken.add(s.id);
      if (s.id === p.id) return;

      const old = p.id;
      P.delete(old);
      goneP.add(old);
      [...I].forEach(([key, row]) => {
        if (row.playlistId !== old) return;
        I.delete(key);
        putI.delete(key);
        row.playlistId = s.id;
        const next = itemKey(s.id, row.t);
        I.set(next, row);
        putI.add(next);
      });

      const adopted = { ...p, id: s.id, name: s.name };
      delete adopted.seq;
      // A note typed here and not there is kept, and goes up.
      if (!s.note && p.note) adopted.dirty = now + Math.random();
      P.set(s.id, adopted);
      putP.add(s.id);
      reorder.add(s.id);
    });
  }

  /* Changes, oldest first. */
  const incoming = [...(resp.changes || [])].sort((a, b) => a.seq - b.seq);
  const winners = new Set();

  incoming.forEach((ch) => {
    if (ch.kind === 'playlist') {
      const tag = `playlist|${ch.id}`;
      winners.add(tag);
      const forced = rejected.has(tag);
      const row = P.get(ch.id);
      if (row && row.dirty && !forced) return;

      if (ch.deleted) {
        if (!row) return;
        const holds = [...I.values()].some((i) => i.playlistId === ch.id && !i.deleted && unsent(i));
        if (holds && !forced) return;
        dropList(ch.id);
        applied++;
        return;
      }
      const next = {
        ...(row || {}),
        id: ch.id,
        name: ch.name,
        note: ch.note || '',
        created: ch.created,
        updated: ch.updated,
        order: Array.isArray(ch.order) ? ch.order : [],
        seq: ch.seq,
        dirty: 0
      };
      delete next.deleted;
      P.set(ch.id, next);
      putP.add(ch.id);
      reorder.add(ch.id);
      applied++;
      return;
    }

    if (ch.kind === 'item') {
      const key = itemKey(ch.playlistId, ch.t);
      const tag = `item|${key}`;
      winners.add(tag);
      const forced = rejected.has(tag);
      const row = I.get(key);

      if (ch.deleted) {
        if (!row) return;
        // Ours is newer than anything the server knows, or not sent yet.
        if (!forced && unsent(row)) return;
        dropItem(key);
        applied++;
        return;
      }
      if (row && row.dirty && !forced) return;

      const next = {
        ...(row || { id: newId(), pos: -1 }),
        playlistId: ch.playlistId,
        t: ch.t,
        added: ch.added,
        rid: ch.rid || null,
        a: Array.isArray(ch.a) ? ch.a : [],
        len: ch.len || '',
        c: ch.c || 'main',
        sz: ch.sz || '',
        p: ch.p || 0,
        d: ch.d || '',
        se: Boolean(ch.se),
        cov: ch.cov || null,
        updated: ch.updated,
        seq: ch.seq,
        dirty: 0
      };
      delete next.deleted;
      I.set(key, next);
      putI.add(key);
      reorder.add(ch.playlistId);
      applied++;
      return;
    }

    if (ch.kind === 'play') {
      if (ch.at <= cleared) return;
      const row = L.get(ch.id);
      if (!row) {
        L.set(ch.id, {
          id: ch.id, rid: ch.rid || null, t: ch.t || '', c: ch.c || 'main',
          cov: ch.cov || null, at: ch.at, sec: ch.sec || 0, seq: ch.seq, dirty: 0
        });
        putL.add(ch.id);
        applied++;
      } else if ((ch.sec || 0) > (row.sec || 0)) {
        row.sec = ch.sec;
        row.seq = ch.seq;
        putL.add(ch.id);
        applied++;
      }
    }
  });

  /* A rejected record with no server version means the other side does
     not have it at all: drop ours. */
  (resp.rejected || []).forEach((r) => {
    const tag = `${r.kind}|${r.key}`;
    if (winners.has(tag)) {
      const map = r.kind === 'playlist' ? P : r.kind === 'item' ? I : L;
      const row = map.get(r.key);
      if (row) row.dirty = 0;
      return;
    }
    if (r.kind === 'item') dropItem(r.key);
    else if (r.kind === 'play' && L.has(r.key)) { L.delete(r.key); putL.delete(r.key); goneL.add(r.key); }
  });

  /* What was pushed and not refused is now the server's too. */
  (ctx.sent || []).forEach((rec) => {
    const key = rec.kind === 'item' ? itemKey(rec.playlistId, rec.t) : rec.id;
    const tag = `${rec.kind}|${key}`;
    if (rejected.has(tag)) return;
    const map = rec.kind === 'playlist' ? P : rec.kind === 'item' ? I : L;
    const row = map.get(key);
    if (!row) return;

    const stamp = (ctx.stamps && ctx.stamps.get(tag)) || 0;
    row.seq = resp.cursor;
    if ((row.dirty || 0) === stamp) row.dirty = 0;
    if (rec.kind === 'playlist') row.order = rec.order;
    (rec.kind === 'playlist' ? putP : rec.kind === 'item' ? putI : putL).add(key);

    if (row.deleted && !row.dirty) {
      if (rec.kind === 'playlist') dropList(key);
      else dropItem(key);
    }
  });

  /* History the server cleared. */
  [...L].forEach(([id, row]) => {
    if (row.at > cleared) return;
    L.delete(id);
    putL.delete(id);
    goneL.add(id);
  });

  /* Positions: the order the playlist record says, or the order held
     here while that order is itself waiting to be sent. */
  const grouped = liveByList([...I.values()]);
  reorder.forEach((pid) => {
    const p = P.get(pid);
    if (!p || p.deleted) return;
    const items = grouped.get(pid) || [];
    const base = p.dirty
      ? items.filter((i) => i.pos >= 0).sort((a, b) => a.pos - b.pos).map((i) => i.t)
      : (p.order || []);
    const rows = new Map(items.map((i) => [i.t, i]));
    effectiveOrder(base, items).forEach((t, pos) => {
      const row = rows.get(t);
      if (row.pos !== pos) {
        row.pos = pos;
        putI.add(itemKey(pid, t));
      }
    });
  });

  const out = { meta: {}, result: { applied } };
  out.meta.cursor = Math.max(meta.cursor || 0, resp.cursor || 0);
  out.meta.historyClearedAt = cleared;
  out.meta.lastSynced = resp.serverTime || now;
  if (ctx.server !== undefined) out.meta.server = ctx.server;
  if (ctx.sentClear !== undefined && (meta.clearPending || 0) <= ctx.sentClear) out.meta.clearPending = undefined;

  out.put = {
    playlists: [...putP].map((k) => P.get(k)).filter(Boolean),
    items: [...putI].map((k) => I.get(k)).filter(Boolean),
    plays: [...putL].map((k) => L.get(k)).filter(Boolean)
  };
  out.remove = { playlists: [...goneP], items: [...goneI], plays: [...goneL] };
  return out;
}

/**
 * Forget everything sync knew, and keep the data: every row loses its
 * `seq` and `dirty` (so all of it counts as unsent again), tombstones
 * go, and the bookkeeping is cleared. Used when a first sync begins and
 * by Stop syncing.
 */
export function resetOps(state) {
  const plain = ({ seq, dirty, order, ...rest }) => rest;
  return {
    put: {
      playlists: state.playlists.filter(alive).map(plain),
      items: state.items.filter(alive).map(plain),
      plays: state.plays.map(plain)
    },
    remove: {
      playlists: state.playlists.filter((r) => r.deleted).map((r) => r.id),
      items: state.items.filter((r) => r.deleted).map((r) => r.id),
      plays: []
    },
    meta: Object.fromEntries(Object.keys(state.meta || {}).map((k) => [k, undefined]))
  };
}

/* ============================================================
   The runner
   ============================================================ */

class SyncError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

function describeFailure(status, data) {
  const said = data && data.error ? `: ${data.error}` : '';
  if (status === 401) return 'The server did not accept the token';
  if (status === 409) return 'The server was reset since the last sync. Press Stop syncing, then Sync now, to start again';
  if (status === 413) return 'The server refused a batch as too large';
  if (status === 429) return 'The server asked for a pause. It will be tried again later';
  if (status === 400) return `The server refused the data${said}`;
  if (status >= 500) return `The server had a problem (${status})`;
  return `The server answered ${status}${said}`;
}

/**
 * Start sync in the shell. Returns the object the Settings page uses,
 * or null outside the desktop app.
 *
 *   now()        sync once, on purpose. The only way a first sync starts.
 *   refresh()    re-read the settings and the status line, no request.
 *   status()     { state, message, at, pushed, pulled, rejected }
 *   subscribe()  call back on every status change; returns the stop.
 *   stop()       forget the server and the token, keep the data.
 */
export function initSync({ frame, toast } = {}) {
  if (!inTauri) return null;

  let status = { state: 'off', message: 'Sync is off', at: 0, pushed: 0, pulled: 0, rejected: 0 };
  const listeners = new Set();
  let running = null;
  let again = false;
  let timer = null;
  let pendingSince = 0;
  let failures = 0;
  let notBefore = 0;
  let lastTried = 0;

  const say = (text, bad = false) => { try { if (toast) toast(text, bad); } catch { /* no toast */ } };

  function setStatus(patch) {
    status = { ...status, ...patch };
    listeners.forEach((fn) => { try { fn({ ...status }); } catch { /* a page that went away */ } });
  }

  async function readConfig() {
    const s = await invoke('settings_get');
    return { url: String(s.sync_url || ''), tokenSet: Boolean(s.sync_token_set) };
  }

  async function request(body) {
    const text = JSON.stringify({ protocol: 1, device: DEVICE, ...body });
    let reply = await invoke('sync_request', { body: text });
    for (const wait of WAKE_WAITS) {
      if (![502, 503, 504].includes(reply.status)) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
      reply = await invoke('sync_request', { body: text });
    }
    let data = null;
    try { data = JSON.parse(reply.body); } catch { /* not JSON */ }
    if (reply.status === 200 && data && typeof data.cursor === 'number') return data;
    throw new SyncError(describeFailure(reply.status, data), reply.status);
  }

  /** Everything the server has, page by page, as one reply. Only a first
      sync needs it whole: it matches playlists by name. */
  async function pullEverything() {
    let resp = await request({ since: 0, push: [] });
    const changes = [...resp.changes];
    while (resp.more) {
      resp = await request({ since: resp.cursor, push: [] });
      changes.push(...resp.changes);
    }
    return { ...resp, changes };
  }

  /** The v3 export, written where the person chooses, before the first
      byte leaves the machine. No file, no sync. */
  async function backup() {
    const payload = await exportAll();
    const name = `999-backup-before-sync-${new Date().toISOString().slice(0, 10)}.json`;
    const where = await invoke('save_text', { name, text: JSON.stringify(payload, null, 2) });
    if (!where) {
      throw new SyncError('Sync did not start because no backup was saved. Press Sync now and choose where to keep it');
    }
    return where;
  }

  async function pass(manual) {
    const cfg = await readConfig();
    if (!cfg.url || !cfg.tokenSet) {
      setStatus({ state: 'off', message: 'Sync is off. Save a server address and a token to turn it on.' });
      return;
    }

    const before = await syncRead();
    const first = before.meta.server !== cfg.url;
    if (first && !manual) {
      setStatus({
        state: 'ready',
        message: 'Ready. Press Sync now to start. A backup of your playlists is saved first.'
      });
      return;
    }

    setStatus({ state: 'running', message: first ? 'Starting sync' : 'Syncing' });
    let pushed = 0;
    let pulled = 0;
    let refused = 0;
    let applied = 0;
    let savedTo = '';

    if (first) {
      savedTo = await backup();
      await syncTransact((st) => resetOps(st));
      const pull = await pullEverything();
      const r = await syncTransact((st) => mergeResponse(st, pull, { first: true, server: cfg.url }));
      pulled += pull.changes.length;
      applied += r.applied;
    }

    for (let round = 0; round < 50; round++) {
      const st = await syncRead();
      const { records, stamps } = buildPush(st);
      const clear = st.meta.clearPending;
      // After the first request, go on only while something is left.
      if (round > 0 && records.length === 0 && !clear) break;

      const sent = records.slice(0, CHUNK);
      const body = { since: st.meta.cursor || 0, push: sent };
      if (clear) body.clearHistoryAt = clear;

      const resp = await request(body);
      const r = await syncTransact((cur) => mergeResponse(cur, resp, {
        sent, stamps, sentClear: clear, server: cfg.url
      }));
      pushed += sent.length;
      pulled += resp.changes.length;
      refused += resp.rejected.length;
      applied += r.applied;

      // The rest of a long answer, a page at a time, each from where the last ended.
      let page = resp;
      while (page.more) {
        page = await request({ since: page.cursor, push: [] });
        const more = await syncTransact((cur) => mergeResponse(cur, page, { server: cfg.url }));
        pulled += page.changes.length;
        applied += more.applied;
      }
    }

    failures = 0;
    notBefore = 0;
    setStatus({ state: 'idle', message: 'Synced', at: Date.now(), pushed, pulled, rejected: refused });
    if (savedTo) say(`Backup saved to ${savedTo}. Sync is on.`);
    if (applied && frame) {
      try { frame.contentWindow.dispatchEvent(new Event('playlists-changed')); } catch { /* not ours */ }
    }
  }

  async function attempt(manual) {
    if (!manual && Date.now() < notBefore) { schedule(notBefore - Date.now()); return; }
    lastTried = Date.now();
    try {
      await pass(manual);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      failures += 1;
      notBefore = Date.now() + Math.min(BACKOFF_START * 2 ** (failures - 1), BACKOFF_MAX);
      setStatus({ state: 'error', message });
      if (manual) say(message, true);
    }
  }

  function run(manual) {
    if (running) { again = true; return running; }
    running = attempt(manual).finally(() => {
      running = null;
      if (again) { again = false; schedule(); }
    });
    return running;
  }

  /** Debounced, with a ceiling, so a song being listened to cannot keep
      pushing the next sync back for ever. */
  function schedule(delay = DEBOUNCE) {
    const now = Date.now();
    if (!pendingSince) pendingSince = now;
    const wait = Math.max(0, Math.min(delay, pendingSince + MAX_WAIT - now));
    clearTimeout(timer);
    timer = setTimeout(() => { pendingSince = 0; run(false); }, wait);
  }

  /* Triggers: a change anywhere, the app opening and coming back,
     coming back online, and every few minutes while it is open. */
  try {
    const channel = new BroadcastChannel('999-sync');
    channel.onmessage = () => schedule();
  } catch { /* no channel: the timers still run */ }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastTried > VISIBLE_GAP) schedule(1000);
  });
  window.addEventListener('online', () => schedule(1000));
  setTimeout(() => run(false), FIRST_AFTER);
  setInterval(() => run(false), EVERY);

  return {
    now: () => run(true),
    refresh: () => run(false),
    status: () => ({ ...status }),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async stop() {
      await invoke('settings_set', { key: 'sync_url', value: '' });
      await invoke('settings_set', { key: 'sync_token', value: '' });
      await syncTransact((st) => resetOps(st));
      failures = 0;
      notBefore = 0;
      setStatus({ state: 'off', message: 'Sync is off. Your playlists and history stay as they are on this machine.' });
    }
  };
}
