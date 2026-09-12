/* ============================================================
   Listening statistics.

   Pure: it is handed the `plays` rows out of db.js and hands back
   numbers. No DOM, no storage, no clock other than the one it is
   given, so every figure on the overview can be checked against a
   list of rows in a test.

   A row is { rid, t, c, cov, at, sec }: what was started, when (ms),
   and how many seconds of it were heard. Days are local days, because
   a streak is something a person keeps, and a person lives in a
   timezone.
   ============================================================ */

const DAY = 86400000;

/** Local day number for a timestamp, so consecutive days differ by 1. */
function dayOf(ms) {
  const d = new Date(ms);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
}

/** The best run of consecutive days, and the run that is still going. */
function streaks(days, today) {
  let best = 0;
  let current = 0;
  let run = 0;

  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] === days[i - 1] + 1 ? run + 1 : 1;
    if (run > best) best = run;
  }

  // The streak is alive if the last day played is today, or yesterday
  // with today not yet begun. Anything older has lapsed.
  const last = days[days.length - 1];
  if (days.length && last >= today - 1) current = run;

  return { current, best };
}

/**
 * Everything the overview shows, from the rows.
 *
 * `mainIds` is the set of record ids in the main archive, for the
 * completion figure. Without it that figure is null and the page
 * leaves the tile blank rather than dividing by nothing.
 */
export function computeStats(plays, { mainIds = null, now = Date.now() } = {}) {
  const rows = Array.isArray(plays) ? plays : [];

  let seconds = 0;
  const byTrack = new Map();
  const hours = new Array(24).fill(0);
  const daySet = new Set();

  rows.forEach((row) => {
    seconds += Number(row.sec) || 0;

    const key = row.rid || `t:${row.t}`;
    const entry = byTrack.get(key) || { rid: row.rid || null, t: row.t, c: row.c, cov: row.cov, n: 0, sec: 0 };
    entry.n++;
    entry.sec += Number(row.sec) || 0;
    // The newest snapshot wins, so a corrected title shows corrected
    entry.t = row.t || entry.t;
    entry.cov = row.cov || entry.cov;
    byTrack.set(key, entry);

    hours[new Date(row.at).getHours()]++;
    daySet.add(dayOf(row.at));
  });

  const days = [...daySet].sort((a, b) => a - b);
  const total = rows.length;

  let peakHour = null;
  if (total) {
    let max = -1;
    hours.forEach((n, h) => { if (n > max) { max = n; peakHour = h; } });
  }

  const mostPlayed = [...byTrack.values()]
    .sort((a, b) => b.n - a.n || b.sec - a.sec || a.t.localeCompare(b.t));

  let completion = null;
  if (mainIds && mainIds.size) {
    let played = 0;
    byTrack.forEach((entry) => { if (entry.rid && mainIds.has(entry.rid)) played++; });
    completion = { played, total: mainIds.size };
  }

  // The last fourteen local days, oldest first, true where something
  // was played. What the streak strip draws.
  const today = dayOf(now);
  const recentDays = [];
  for (let d = today - 13; d <= today; d++) recentDays.push(daySet.has(d));

  return {
    total,
    seconds,
    unique: byTrack.size,
    days: days.length,
    avgDaily: days.length ? total / days.length : 0,
    peakHour,
    hours,
    recentDays,
    firstAt: rows.length ? Math.min(...rows.map((r) => Number(r.at) || Infinity)) : null,
    streak: streaks(days, today),
    mostPlayed,
    completion
  };
}

/** 143160 -> "1d 15h 46m". Under a minute reads "0m" rather than
    pretending to a precision nobody wants on a headline figure. */
export function spanText(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const bits = [];
  if (d) bits.push(`${d}d`);
  if (d || h) bits.push(`${h}h`);
  bits.push(`${m}m`);
  return bits.join(' ');
}

/** 18 -> "6pm", 0 -> "12am". */
export function hourText(hour) {
  if (hour === null || hour === undefined) return '';
  const h = Number(hour) % 24;
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${h < 12 ? 'am' : 'pm'}`;
}
