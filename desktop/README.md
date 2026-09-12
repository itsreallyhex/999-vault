# 999, desktop

A Tauri app. A trimmed down version of the site rather than a copy of it: a
player, mainly.

```text
src/          The frontend. Plain ES modules, no bundler.
  index.html    The start screen.
  vault.html    The archive index.
  playlists.html
  js/tauri.js   The only module that talks to Rust.
src-tauri/    The Rust side.
  src/data.rs   Finds the archive on disk, reads its two JSON indexes.
  src/tools.rs  Runs the Python scripts.
```

## Running it

```bash
cd desktop
npm install
npm run dev
```

Needs Rust and, on Windows, the MSVC toolchain with a Windows SDK. Node is
needed only for the Tauri CLI; nothing is bundled and the frontend ships as
the files in `src/`.

## Where it reads the archive

It does not carry its own copy. The catalogue is 1.67 MB, the covers are
102 MB and the audio is nearly 26 GB, so it reads the same folder the site
does. It points at that folder; it never copies it.

Nothing is resolved at compile time. The path is worked out when the app
starts, in this order, first one that exists winning:

1. `NINE_DATA_ROOT` in the environment.
2. `data_root` in `config.toml`, in the OS config directory. On Windows that
   is `%APPDATA%\xyz.juicevault.nine\config.toml`, and the app writes a commented
   template there the first time it runs.
3. A `data` folder beside the executable. This is the portable layout: copy
   the exe and a data folder anywhere together and it works.
4. A `data` folder in the OS app data directory.
5. `web/data` in a checkout above the executable. This is what makes a dev
   build work with no configuration at all, and it finds nothing on a
   machine that has no checkout, which is the correct answer.

The scripts in `tools/` are found the same way, with `NINE_TOOLS_DIR`,
`tools_dir`, a `tools` folder beside the exe, Tauri's bundled resources, and
then `web/tools`.

The app prints both, and which rule found them, on startup.

That is a data dependency, not a code one. Nothing here imports from `web/`.

## What it carries

Two pages:

- **The Vault**, the archive index.
- **Playlists**.

It does not carry the landing page and it does not carry the tribute page.
Those exist to explain the project to somebody arriving at it, and an app that
has already been installed and opened does not need explaining.

Launching it lands on a small screen that routes to one or the other. It does
not open straight into the Vault. The two pages are equals here, and dropping
somebody into the larger of them by default makes the other one feel like a
detour.

## Independent from web/ on purpose

This app shares nothing with `web/`. No imports out of `web/js`, no build step
that copies files across, no symlinks. If both ends up needing the same thing,
both get their own copy of it.

That is a deliberate trade. Keeping them linked would mean every change to the
site had to be weighed against an app that may be built months later, and the
two have different shapes anyway: the site is four pages served over HTTP, the
app is two views in a window with a filesystem underneath it.

## The Python scripts

`save-catalogue.py`, `sync.py` and `save-audio.py` are not going to be
rewritten in Rust. The app will shell out to them as subprocesses and read
what they print.

They already work, they are the only things that know how the archive
responds, and rewriting them would mean maintaining two implementations of the
same fetching rules. The bearer token expiry, the `/stream` fallback for the
three broken records and the cover deduplication all live in those files.

`tools.rs` wires this up: `run_tool` takes one of the three script names,
refuses anything else, and hands back what the script printed. Nothing in the
interface calls it yet, and a long run wants streaming output rather than one
lump at the end, which is a later problem.

How the app locates a Python interpreter, and what it does when it cannot find
one, are still open. It calls `python` and expects it on PATH.
