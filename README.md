# 999

Two projects live in this repo now, and they do not share code.

```text
web/        The site. Four pages, a local Python server, and the scripts
            that save the catalogue, the covers and the audio.
desktop/    A Tauri app over the same archive: a listening overview, the
            Vault, the playlists, a player that survives a tab switch,
            and Discord Rich Presence. Builds, installs and runs.
Assets/     Screenshots for both readmes, plus the mark as an SVG.
```

Each folder is self-contained and has its own readme: `web/README.md` for
how the site works, `desktop/README.md` for the app.

## Running the site

The server has to be started from inside `web/`, because it serves the folder
it sits in:

```bash
cd web
python serve.py          # http://127.0.0.1:8777
```

Opening `web/index.html` straight off the disk will not work. The pages are ES
modules, so the browser refuses them over `file://` and the page comes up
blank. It needs a real server, which is what `serve.py` is for.

The scripts that fetch data are run from `web/` too:

```bash
cd web
python tools/save-catalogue.py     # save the catalogue
python tools/sync.py --check       # see what the archive has added
```

Everything they read and write stays under `web/data/`.

## The desktop app

```bash
cd desktop
npm install
npx tauri build        # release exe and installers under src-tauri/target/
```

It needs Rust and, on Windows, the MSVC build tools with a Windows SDK. See
`desktop/README.md` for the toolchain, where it finds the archive, and what
has and has not been seen running.

It is deliberately independent of `web/`. It does not import from `web/js`,
and nothing copies files between the two at build time. Where both needed the
same module, both have their own copy. They do share the archive on disk,
because 26 GB is not worth duplicating to make a point.

## Notes

`design-system/` sits at the root because both projects can refer to it. It is
reference material from a design skill, not code, and nothing loads it.
