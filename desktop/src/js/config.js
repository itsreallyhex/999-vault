/* ============================================================
   Shared constants.

   Nothing in here touches the DOM or the network. If a value is
   tuned more than once, it belongs in this file.
   ============================================================ */

/** Base URL of the archive. Only metadata and cover endpoints are used. */
export const API_BASE = 'https://api.juicevault.xyz';

/** How long to wait on the catalogue before falling back to the offline
    seed, in ms. The listing normally returns in under two seconds. */
export const REQUEST_TIMEOUT = 12000;

/* The site keeps SNAPSHOT_PATH and SNAPSHOT_TIMEOUT here, pointing at
   data/catalogue.json over HTTP. Neither survives the move to a window:
   the saved copy is read by Rust and handed over through a command, so
   there is no URL to resolve and no request to time out. See
   tauri.js and the read_catalogue command. */

/** Who the overview greets. One user, one machine, so a constant
    rather than an account. Empty string for a plain "Hey". */
export const OWNER = 'Hex';

/** Cards appended per batch. The catalogue runs to a few thousand rows,
    so the grid fills progressively rather than all at once. */
export const PAGE_SIZE = 60;

/** Debounce on the search field, in ms. Search scans titles plus every
    alternate name, so it is worth not running it on every keystroke. */
export const SEARCH_DELAY = 160;

/** Categories the archive uses, in the order they appear as filter chips. */
export const CATEGORIES = ['main', 'instrumental', 'stem', 'cut', 'released', 'remaster'];

/** Generated-cover palettes: [base, mid, detail].
    Each is dark enough at the base to carry a light mark. */
export const PALETTES = [
  ['#2E1065', '#7C3AED', '#F0ABFC'], ['#0C4A6E', '#0891B2', '#A5F3FC'],
  ['#4C0519', '#E11D48', '#FDA4AF'], ['#1C1917', '#D97706', '#FDE68A'],
  ['#052E16', '#16A34A', '#BBF7D0'], ['#1E1B4B', '#4F46E5', '#C7D2FE'],
  ['#3B0764', '#C026D3', '#F5D0FE'], ['#0F172A', '#475569', '#E2E8F0'],
  ['#450A0A', '#EA580C', '#FED7AA'], ['#042F2E', '#0D9488', '#99F6E4'],
  ['#111827', '#9333EA', '#DDD6FE'], ['#3F0F0F', '#B91C1C', '#FCA5A5'],
  ['#0B1120', '#38BDF8', '#BAE6FD'], ['#1A2E05', '#65A30D', '#D9F99D'],
  ['#2A0A18', '#DB2777', '#FBCFE8'], ['#171717', '#A3A3A3', '#FAFAFA']
];

/** Number of cover compositions in style.css, as `.cover[data-art="0..7"]`.
    These are eight different layouts, not eight colourways. */
export const COMPOSITIONS = 8;
