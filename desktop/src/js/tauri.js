/* ============================================================
   The bridge to Rust.

   THE ONLY MODULE THAT TALKS TO THE BACKEND. Everything else asks
   this one, the same way api.js is the only module that touches the
   network and db.js the only one that touches IndexedDB.

   The site reads the archive over HTTP, because it has a server in
   front of it. This app has no server: the window is a webview over
   local files, so the catalogue and the audio index come back through
   Tauri commands, and the covers and the songs are turned into asset
   URLs the webview will load.

   `withGlobalTauri` is on in tauri.conf.json, which is what puts
   __TAURI__ on the window. That is deliberate: it keeps the frontend
   plain ES modules with no bundler and no npm packages at runtime,
   which is how the rest of this project is built.
   ============================================================ */

const TAURI = globalThis.__TAURI__ || null;

/** False in a plain browser, which is how the fallbacks below stay
    honest rather than throwing. */
export const inTauri = Boolean(TAURI);

export function invoke(command, args = {}) {
  if (!TAURI) return Promise.reject(new Error('not running under Tauri'));
  return TAURI.core.invoke(command, args);
}

/** A native path the webview will actually load. */
function fileSrc(path) {
  return TAURI ? TAURI.core.convertFileSrc(path) : path;
}

/* ---------- The archive on disk ---------- */

let root = null;
let info = null;
let pending = null;

/** The archive folder, or null if there is not a usable one. */
export function archive() {
  return root;
}

/** Everything Rust replied, whether it found an archive or not. Carries
    the config file path, which is the useful thing to show when it did
    not find one. */
export function archiveInfo() {
  return info;
}

/**
 * Ask Rust where the archive is. Cached: every later call gets the same
 * promise, so the covers do not each trigger their own round trip.
 *
 * A failure resolves to null rather than rejecting. No archive on disk
 * is a normal state, and it is what sends api.js to the live listing.
 */
export function loadArchive() {
  if (pending) return pending;

  pending = invoke('data_root')
    .then((reply) => {
      info = reply || null;
      root = reply && reply.exists ? reply : null;
      return root;
    })
    .catch(() => {
      info = null;
      root = null;
      return null;
    });

  return pending;
}

/** Join path parts with whatever separator the root came back using. */
function join(...parts) {
  const sep = root && root.path.includes('\\') ? '\\' : '/';
  return parts.join(sep).replace(/[\\/]+/g, sep);
}

/**
 * A catalogue cover path into something loadable.
 *
 * The saved catalogue carries `data/covers/<sha1>.webp`, written
 * relative to web/. The leading `data/` is dropped because the root
 * already points at that folder.
 */
export function resolveAsset(path) {
  if (!path || !root || !root.covers) return null;
  const rel = String(path).replace(/^[\\/]+/, '').replace(/^data[\\/]/, '');
  return fileSrc(join(root.path, rel));
}

/** A saved filename out of the audio index into something playable. */
export function resolveAudio(file) {
  if (!file || !root || !root.audio) return null;
  return fileSrc(join(root.path, 'audio', file));
}
