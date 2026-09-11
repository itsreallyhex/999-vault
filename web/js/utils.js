/* ============================================================
   Small generic helpers.

   Everything here is reusable and mostly pure. `make` is the one
   exception: it is the DOM shorthand used by every render function.
   ============================================================ */

/** Create an element, optionally with a class and text content. */
export function make(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** "3:16" -> 196. Used for sorting by duration. */
export function seconds(len) {
  const parts = String(len || '0:00').split(':').map(Number);
  return parts.length === 2 ? parts[0] * 60 + parts[1] : 0;
}

/** 196 -> "3:16", 3766 -> "1:02:46". The inverse of `seconds`, widened
    to hours, for the running time of a playlist. */
export function clock(total) {
  const whole = Math.max(0, Math.round(total || 0));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "12.4 MB" -> 12400000. Used for sorting by size, so approximate is fine. */
export function bytes(size) {
  const m = /([\d.]+)\s*(KB|MB|GB)/i.exec(size || '');
  if (!m) return 0;
  const scale = { kb: 1e3, mb: 1e6, gb: 1e9 }[m[2].toLowerCase()];
  return parseFloat(m[1]) * scale;
}

/** "2026-02-12" -> "12 Feb 2026". Parsed as UTC so the date never
    shifts by a day depending on the reader's timezone. */
export function niceDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d)) return iso || '';
  return d.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'
  });
}

/** 3879 -> "3,879". The catalogue is large enough that raw digits are hard to read. */
export function group(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** FNV-1a. Small, fast and stable across reloads, which is what the
    generated covers need: the same title must always hash the same. */
export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Trailing debounce. Returns a wrapped fn that runs once things go quiet. */
export function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}
