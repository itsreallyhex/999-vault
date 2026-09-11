# 999

Two projects live in this repo now, and they do not share code.

```text
web/        The site. Four pages, a local Python server, and the scripts
            that save the catalogue, the covers and the audio. This is
            the finished, working project.
desktop/    A desktop app, not started yet. An empty skeleton.
```

Each folder is self-contained. `web/` has its own readme covering how the
site actually works, which is the one worth reading.

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

`desktop/` is an empty folder structure and nothing else. No Tauri project has
been scaffolded and nothing has been installed. See `desktop/README.md` for
what it is meant to become.

It is deliberately independent of `web/`. It will not import from `web/js`, and
nothing copies files between the two at build time. Some duplication between
them is expected and fine.

## Notes

`design-system/` sits at the root because both projects can refer to it. It is
reference material from a design skill, not code, and nothing loads it.
