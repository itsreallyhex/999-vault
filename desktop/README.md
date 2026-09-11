# 999, desktop

Nothing has been built here yet. This folder is an empty skeleton so the shape
of the thing is written down somewhere before any of it exists.

```text
src/          The frontend. Empty.
src-tauri/    The Tauri side. Empty.
```

No Tauri project has been scaffolded, no dependencies have been installed, and
there is no build. Creating the project is the first real step and it has not
been taken.

## What it is meant to be

A desktop app built with Tauri, and a trimmed down version of the site rather
than a copy of it. A player, mainly.

It carries two pages:

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

This is a decision recorded early, not something to implement now. How the app
locates a Python interpreter, and what it does when it cannot find one, are
open questions.
