// node --test sync.test.js (from desktop/)
//
// The rules half of src/js/sync.js: no DOM, no IndexedDB, no network.
// Rows are plain objects shaped like db.js's, and `apply` stands in for
// db.syncTransact so one result can feed the next.
import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveOrder, buildPush, mergeResponse, resetOps, itemKey } from './src/js/sync.js';

/* ---------- Rows and server replies ---------- */

const list = (id, name, extra = {}) => ({ id, name, note: '', created: 1, updated: 1, ...extra });
const item = (pid, t, extra = {}) => ({
  id: `row-${pid}-${t}`, playlistId: pid, t, pos: 0, added: 1, rid: null, a: [], len: '3:00',
  c: 'main', sz: '', p: 0, d: '', se: false, cov: null, ...extra
});
const play = (id, at, sec, extra = {}) => ({ id, rid: null, t: 'Song', c: 'main', cov: null, at, sec, ...extra });
const state = (o = {}) => ({ playlists: [], items: [], plays: [], meta: {}, ...o });

const chList = (id, name, seq, extra = {}) => ({
  kind: 'playlist', id, name, note: '', created: 1, updated: 1, deleted: false, order: [], seq, writer: 'phone', ...extra
});
const chItem = (pid, t, seq, extra = {}) => ({
  kind: 'item', playlistId: pid, t, added: 1, rid: null, a: [], len: '', c: 'main', sz: '', p: 0, d: '',
  se: false, cov: null, updated: 1, deleted: false, seq, writer: 'phone', ...extra
});
const chPlay = (id, at, sec, seq, extra = {}) => ({
  kind: 'play', id, rid: null, t: 'Song', c: 'main', cov: null, at, sec, seq, writer: 'phone', ...extra
});
const resp = (o = {}) => ({ cursor: 10, changes: [], rejected: [], historyClearedAt: 0, serverTime: 1000, ...o });

/** Apply a list of operations to a state, the way db.syncTransact does. */
function apply(st, ops) {
  const out = { playlists: [...st.playlists], items: [...st.items], plays: [...st.plays], meta: { ...st.meta } };
  const upsert = (rows, put) => {
    const at = rows.findIndex((r) => r.id === put.id);
    if (at >= 0) rows[at] = put; else rows.push(put);
  };
  ['playlists', 'items', 'plays'].forEach((k) => {
    const gone = new Set((ops.remove && ops.remove[k]) || []);
    out[k] = out[k].filter((r) => !gone.has(r.id));
    ((ops.put && ops.put[k]) || []).forEach((row) => upsert(out[k], row));
  });
  Object.entries(ops.meta || {}).forEach(([k, v]) => {
    if (v === undefined) delete out.meta[k]; else out.meta[k] = v;
  });
  return out;
}

const merge = (st, r, ctx) => apply(st, mergeResponse(st, r, { now: 5000, newId: () => `new-${Math.random()}`, ...ctx }));
const titles = (st, pid) => st.items.filter((i) => i.playlistId === pid && !i.deleted)
  .sort((a, b) => a.pos - b.pos).map((i) => i.t);

/* ---------- The order ---------- */

test('effectiveOrder: listed and alive first, then the rest by when they were added', () => {
  const items = [item('P', 'a', { added: 3 }), item('P', 'b', { added: 1 }), item('P', 'c', { added: 2 }), item('P', 'd', { added: 9 })];
  assert.deepEqual(effectiveOrder(['c', 'gone', 'a', 'c'], items), ['c', 'a', 'b', 'd']);
  assert.deepEqual(effectiveOrder([], items), ['b', 'c', 'a', 'd']);
  assert.deepEqual(effectiveOrder(undefined, []), []);
});

test('a change to the order moves the songs here', () => {
  const st = state({
    playlists: [list('P', 'Mix', { seq: 1, order: ['a', 'b'] })],
    items: [item('P', 'a', { pos: 0, seq: 1 }), item('P', 'b', { pos: 1, seq: 1 })]
  });
  const next = merge(st, resp({ changes: [chList('P', 'Mix', 4, { order: ['b', 'a'] })] }));
  assert.deepEqual(titles(next, 'P'), ['b', 'a']);
});

test('a new song from the server lands after the listed ones, and a playlist we are still sending keeps its own order', () => {
  const st = state({
    playlists: [list('P', 'Mix', { seq: 1, dirty: 7, order: ['a', 'b'] })],
    items: [item('P', 'b', { pos: 0, seq: 1 }), item('P', 'a', { pos: 1, seq: 1 })]
  });
  const next = merge(st, resp({
    changes: [chList('P', 'Mix', 6, { order: ['a', 'b'] }), chItem('P', 'c', 7, { added: 50 })]
  }));
  // the server's order change is skipped while ours is waiting to go up
  assert.deepEqual(titles(next, 'P'), ['b', 'a', 'c']);
  assert.equal(next.playlists[0].dirty, 7);
});

/* ---------- First sync ---------- */

test('first sync: names match trimmed and ignoring case, ids are adopted, songs merge by title', () => {
  const st = state({
    playlists: [list('L1', ' Gym Mix', { created: 1 }), list('L2', 'chill', { created: 2 }), list('L3', 'Only here', { created: 3 })],
    items: [
      item('L1', 'x', { pos: 0 }), item('L1', 'y', { pos: 1 }),
      item('L2', 'z', { pos: 0 }),
      item('L3', 'q', { pos: 0 })
    ]
  });
  const reply = resp({
    changes: [
      chList('S1', 'GYM MIX', 1, { order: ['y', 'w'], created: 1 }),
      chItem('S1', 'y', 2), chItem('S1', 'w', 3),
      chList('S2', 'Chill', 4, { created: 2 })
    ],
    cursor: 4
  });
  const next = merge(st, reply, { first: true, server: 'https://sync.example' });

  assert.deepEqual(next.playlists.map((p) => p.id).sort(), ['L3', 'S1', 'S2']);
  assert.ok(next.playlists.every((p) => !/imported/i.test(p.name)), 'no (imported 2) copies');
  assert.equal(next.items.filter((i) => i.playlistId === 'L1' || i.playlistId === 'L2').length, 0);

  // the shared song is the server's now, the others are ours to send
  assert.deepEqual(titles(next, 'S1'), ['y', 'w', 'x']);
  assert.equal(next.items.find((i) => i.playlistId === 'S1' && i.t === 'y').seq, 2);
  assert.equal(next.items.find((i) => i.playlistId === 'S1' && i.t === 'x').seq, undefined);
  assert.deepEqual(titles(next, 'S2'), ['z']);
  assert.equal(next.meta.server, 'https://sync.example');
  assert.equal(next.meta.cursor, 4);

  const { records } = buildPush(next);
  const sentItems = records.filter((r) => r.kind === 'item').map((r) => `${r.playlistId}:${r.t}`).sort();
  assert.deepEqual(sentItems, ['L3:q', 'S1:x', 'S2:z']);
  assert.deepEqual(records.filter((r) => r.kind === 'playlist').map((r) => r.id), ['L3']);
});

test('first sync: of two local playlists with one name, one adopts and the other is sent as itself', () => {
  const st = state({
    playlists: [list('L1', 'Mix', { created: 1 }), list('L2', 'mix', { created: 2 })]
  });
  const next = merge(st, resp({ changes: [chList('S1', 'Mix', 1)] }), { first: true });
  assert.deepEqual(next.playlists.map((p) => p.id).sort(), ['L2', 'S1']);
});

test('first sync: a song the server has deleted stays here and goes up again', () => {
  const st = state({
    playlists: [list('L1', 'Mix')],
    items: [item('L1', 'x', { pos: 0 })]
  });
  const next = merge(st, resp({
    changes: [chList('S1', 'mix', 1), chItem('S1', 'x', 2, { deleted: true })]
  }), { first: true });
  assert.deepEqual(titles(next, 'S1'), ['x']);
  assert.equal(next.items[0].seq, undefined);
});

/* ---------- What the server says ---------- */

test('a remote tombstone removes an acknowledged song, never one we have not sent', () => {
  const st = state({
    playlists: [list('P', 'Mix', { seq: 1 })],
    items: [
      item('P', 'a', { pos: 0, seq: 1 }),
      item('P', 'b', { pos: 1, seq: 1, dirty: 9 }),
      item('P', 'c', { pos: 2 })
    ]
  });
  const gone = (t, seq) => chItem('P', t, seq, { deleted: true });
  const next = merge(st, resp({ changes: [gone('a', 5), gone('b', 6), gone('c', 7), gone('unknown', 8)] }));
  assert.deepEqual(titles(next, 'P').sort(), ['b', 'c']);
  assert.equal(next.items.length, 2);
});

test('a remote playlist tombstone takes the playlist and its songs, unless a song of ours is still to go', () => {
  const st = state({
    playlists: [list('P', 'Mix', { seq: 1 }), list('Q', 'Other', { seq: 1 })],
    items: [
      item('P', 'a', { seq: 1 }),
      item('Q', 'b', { seq: 1 }), item('Q', 'new', { pos: 1, dirty: 3 })
    ]
  });
  const next = merge(st, resp({
    changes: [chList('P', 'Mix', 5, { deleted: true }), chList('Q', 'Other', 6, { deleted: true })]
  }));
  assert.deepEqual(next.playlists.map((p) => p.id), ['Q']);
  assert.deepEqual(next.items.map((i) => i.t).sort(), ['b', 'new']);
});

test('a playlist that came back with a new song is made again, songs and all', () => {
  const next = merge(state(), resp({
    changes: [chList('P', 'Mix', 3, { order: ['b'] }), chItem('P', 'b', 4)]
  }));
  assert.deepEqual(next.playlists.map((p) => p.name), ['Mix']);
  assert.deepEqual(titles(next, 'P'), ['b']);
  assert.equal(next.playlists[0].dirty, 0);
});

test('a change to a row we are still sending is left for our push to settle', () => {
  const st = state({
    playlists: [list('P', 'My name', { seq: 1, dirty: 4 })],
    items: [item('P', 'a', { seq: 1, dirty: 5, p: 99 })]
  });
  const next = merge(st, resp({ changes: [chList('P', 'Their name', 8), chItem('P', 'a', 9, { p: 1 })] }));
  assert.equal(next.playlists[0].name, 'My name');
  assert.equal(next.items[0].p, 99);
});

test('a rejected key takes the server version and drops our mark; one the server lacks is dropped', () => {
  const st = state({
    playlists: [list('P', 'Phone name', { seq: 1, dirty: 4 })],
    items: [item('P', 'a', { seq: 1, dirty: 5 }), item('P', 'z', { pos: 1, dirty: 6 })],
    plays: [play('old', 100, 3, { dirty: 2 })]
  });
  const next = merge(st, resp({
    changes: [chList('P', 'Desktop name', 8)],
    rejected: [
      { key: 'P', kind: 'playlist', reason: 'changed-on-desktop' },
      { key: itemKey('P', 'z'), kind: 'item', reason: 'playlist-deleted-on-desktop' },
      { key: 'old', kind: 'play', reason: 'history-cleared' }
    ],
    historyClearedAt: 500
  }));
  assert.equal(next.playlists[0].name, 'Desktop name');
  assert.equal(next.playlists[0].dirty, 0);
  assert.deepEqual(next.items.map((i) => i.t), ['a']);
  assert.equal(next.plays.length, 0);
});

/* ---------- Plays ---------- */

test('plays: union by id, the larger sec wins, nothing at or before the clear mark comes back', () => {
  const st = state({
    plays: [play('u1', 1000, 10, { seq: 1 }), play('u2', 2000, 40, { seq: 2 }), play('old', 50, 5, { dirty: 1 })]
  });
  const next = merge(st, resp({
    changes: [
      chPlay('u1', 1000, 30, 5),    // larger: taken
      chPlay('u2', 2000, 5, 6),     // smaller: ours stays
      chPlay('u3', 3000, 7, 7),     // new: added
      chPlay('cleared', 60, 9, 8)   // at the mark: ignored
    ],
    historyClearedAt: 100
  }));
  const by = Object.fromEntries(next.plays.map((p) => [p.id, p.sec]));
  assert.deepEqual(by, { u1: 30, u2: 40, u3: 7 });
  assert.equal(next.meta.historyClearedAt, 100);
});

/* ---------- Sending ---------- */

test('buildPush: unsent rows go, acknowledged ones do not, and a song added alone leaves the playlist record out', () => {
  const st = state({
    playlists: [list('P', 'Mix', { seq: 1, order: ['a', 'b'] })],
    items: [
      item('P', 'a', { pos: 0, seq: 1 }),
      item('P', 'b', { pos: 1, seq: 1 }),
      item('P', 'c', { pos: 2, dirty: 8, added: 5 })
    ],
    plays: [play('u1', 10, 1, { seq: 1 }), play('u2', 20, 2, { dirty: 3 })]
  });
  const { records, stamps } = buildPush(st);
  assert.deepEqual(records.map((r) => `${r.kind}:${r.id || r.t}`), ['item:c', 'play:u2']);
  assert.equal(stamps.get(`item|${itemKey('P', 'c')}`), 8);
});

test('buildPush: removing a song and adding it back rewrites the order, because the server still lists it where it was', () => {
  const st = state({
    playlists: [list('P', 'Mix', { seq: 1, order: ['a', 'b'] })],
    items: [item('P', 'b', { pos: 0, seq: 1 }), item('P', 'a', { pos: 1, dirty: 9, added: 50 })]
  });
  const { records } = buildPush(st);
  const record = records.find((r) => r.kind === 'playlist');
  assert.deepEqual(record.order, ['b', 'a']);
});

test('buildPush: a move marks the playlist, and a deleted one goes as a tombstone', () => {
  const st = state({
    playlists: [list('P', 'Mix', { seq: 1, dirty: 2, order: ['a'] }), list('Q', 'Gone', { seq: 1, dirty: 3, deleted: true })],
    items: [item('P', 'a', { pos: 0, seq: 1 }), item('Q', 'z', { seq: 1, dirty: 3, deleted: true, pos: -1 })]
  });
  const { records } = buildPush(st);
  const q = records.find((r) => r.id === 'Q');
  assert.equal(q.deleted, true);
  assert.ok(records.find((r) => r.kind === 'item' && r.t === 'z').deleted);
  assert.ok(records.find((r) => r.id === 'P'));
});

test('buildPush: a title the server cannot hold stays here instead of spoiling the push', () => {
  const st = state({
    playlists: [list('P', 'Mix', { seq: 1, order: [] })],
    items: [item('P', 'x'.repeat(301), { pos: 0, dirty: 1 }), item('P', 'ok', { pos: 1, dirty: 1 })]
  });
  const { records } = buildPush(st);
  assert.deepEqual(records.map((r) => r.t), ['ok']);
});

test('an acknowledged push clears the mark only where the row has not changed since', () => {
  const st = state({
    playlists: [list('P', 'Mix', { seq: 1, dirty: 5, order: [] })],
    items: [item('P', 'a', { pos: 0, dirty: 6 }), item('P', 'b', { pos: 1, dirty: 7 })],
    plays: [play('u1', 10, 1, { dirty: 4 })]
  });
  const { records, stamps } = buildPush(st);
  // b is edited again while the request is in flight
  const moved = { ...st, items: [st.items[0], { ...st.items[1], dirty: 99 }] };
  const next = merge(moved, resp({ cursor: 20 }), { sent: records, stamps });

  const row = (t) => next.items.find((i) => i.t === t);
  assert.equal(row('a').dirty, 0);
  assert.equal(row('a').seq, 20);
  assert.equal(row('b').dirty, 99);
  assert.equal(row('b').seq, 20);
  assert.equal(next.plays[0].dirty, 0);
  assert.deepEqual(next.playlists[0].order, ['a', 'b']);
  assert.equal(next.meta.cursor, 20);
  // and now only b is left to send
  assert.deepEqual(buildPush(next).records.map((r) => r.t), ['b']);
});

test('an acknowledged tombstone is deleted for real, a rejected one is not', () => {
  const st = state({
    playlists: [list('P', 'Mix', { seq: 1, dirty: 5, deleted: true })],
    items: [item('P', 'a', { seq: 1, dirty: 5, deleted: true, pos: -1 })]
  });
  const { records, stamps } = buildPush(st);

  const acked = merge(st, resp({ cursor: 30 }), { sent: records, stamps });
  assert.equal(acked.playlists.length, 0);
  assert.equal(acked.items.length, 0);

  const refused = merge(st, resp({
    cursor: 30,
    changes: [chList('P', 'Mix', 25), chItem('P', 'a', 26)],
    rejected: [
      { key: 'P', kind: 'playlist', reason: 'playlist-changed-on-desktop' },
      { key: itemKey('P', 'a'), kind: 'item', reason: 'playlist-kept' }
    ]
  }), { sent: records, stamps });
  assert.equal(refused.playlists[0].deleted, undefined);
  assert.equal(refused.items[0].deleted, undefined);
});

test('a clear mark that was sent is forgotten, a newer one is kept', () => {
  const st = state({ meta: { clearPending: 500 } });
  const sent = mergeResponse(st, resp({ historyClearedAt: 400 }), { sentClear: 500 });
  assert.equal('clearPending' in sent.meta, true);
  assert.equal(sent.meta.clearPending, undefined);

  const newer = mergeResponse(state({ meta: { clearPending: 900 } }), resp(), { sentClear: 500 });
  assert.equal('clearPending' in newer.meta, false);
});

/* ---------- Starting over ---------- */

test('resetOps keeps the data, forgets what the server knew, and drops tombstones', () => {
  const st = state({
    playlists: [list('P', 'Mix', { seq: 3, dirty: 0, order: ['a'] }), list('Q', 'Gone', { seq: 3, dirty: 2, deleted: true })],
    items: [item('P', 'a', { seq: 3 }), item('Q', 'z', { seq: 3, deleted: true })],
    plays: [play('u', 1, 1, { seq: 3 })],
    meta: { cursor: 12, server: 'https://x', lastSynced: 5 }
  });
  const next = apply(st, resetOps(st));
  assert.deepEqual(next.playlists.map((p) => p.id), ['P']);
  assert.equal(next.playlists[0].seq, undefined);
  assert.equal(next.playlists[0].order, undefined);
  assert.deepEqual(next.items.map((i) => i.t), ['a']);
  assert.equal(next.items[0].seq, undefined);
  assert.equal(next.plays[0].seq, undefined);
  assert.deepEqual(next.meta, {});
  // all of it counts as unsent again
  assert.equal(buildPush(next).records.length, 3);
});
