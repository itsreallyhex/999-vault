# 999

A personal project. A fan-made site about the Juice WRLD archive: a home page,
a searchable index of the archive called the Vault, playlists saved in the
browser, and a tribute page.

It shows the details of each track and the cover art.

**It is not hosted anywhere.** There is no live URL and there is not going to
be one. I built it for myself, I run it from a local server on my own machine,
and I am the only person who uses it. No deployment, no domain, no accounts, no
analytics. This readme is here so I remember how the thing works later, not to
introduce it to anybody.

![The home page](Assets/landingpage.png)

## What is here

### The Vault

The main page. It lists every entry the archive holds, 3,879 of them, and lets
you dig through them.

![The Vault](Assets/vaultview.png)

What you can do with it:

- Search by title. It searches other names too, which matters, because 1,499
  entries go by more than one name.
- Filter by type: main, instrumental, stem, cut, released and remaster.
- Sort by plays, title, date added or length.
- Click any cover to see the full record: every other name it goes by, how long
  it runs, the file size and when the archive added it.
- Press `/` to jump straight to the search box.

Cards load 60 at a time as you scroll, because putting all 3,879 on the page at
once is too slow to use.

### The tribute

A page about Jarad Higgins, 1998 to 2019. His five studio albums, a short
timeline of what happened, what 999 meant to him, and where to get help if you
need it.

![The tribute page](Assets/tributeview.png)

## Things worth knowing

**The site works online or fully offline. That part is up to me.**

Either way the pages behave the same. The difference is only how much of the
archive is sitting on my own disk:

| | what it needs | disk |
| --- | --- | --- |
| Online | nothing saved, asks the API each load | 0 |
| Catalogue saved | one command | 1.67 MB |
| Catalogue and covers | one command | 103 MB |
| Plus the audio | see [tools/README.md](tools/README.md) | 26 GB |

The listing and the artwork are the easy part. `tools/save-catalogue.py` fetches
both, and needs no account, no key and no setup. Two minutes and the site never
has to touch the network again.

Audio is the involved one, because it is 26 GB and needs a login. That has its
own guide: **[tools/README.md](tools/README.md)**, step by step.

**The API is a fallback now, not the source.**

The site used to ask `api.juicevault.xyz` for the catalogue on every single
load, which meant somebody else's server being slow, down, or gone one day
decided whether my own pages worked. That is a silly thing to accept on a
project that runs entirely on my own machine, so the data lives here instead:

```text
data/catalogue.json    1.67 MB    all 3,879 records
data/covers/            102 MB    1,877 cover images
```

A normal page load now makes **one request, to my own machine**, and nothing
leaves it. Pull the network cable out and the Vault still opens with all 3,879
entries and all their artwork.

### How it decides where to read from

`js/api.js` tries three sources in order and takes the first that works. This
is automatic, every load, with nothing to configure:

1. **The saved copy**, `data/catalogue.json`. Almost always this one.
2. **The live API**, if the saved copy is missing or unreadable. So a fresh
   checkout with no `data/` folder still works, it just goes to the network to
   do it.
3. **The bundled sample**, 39 entries hardcoded in `js/seed.js`, if the archive
   fails too. Enough to see that the page itself is fine and it is the data
   that is not.

The switch is silent and needs no input from me, but it is not hidden: the
indicator at the top of the page always says which one it used.

- **Saved copy**, in blue, with the date the snapshot was taken.
- **Live**, in green, so there is no saved copy and it went to the archive.
- **Offline sample**, in amber, so both failed.

If that reads "Live" when I expected "Saved copy", the snapshot is missing and
I should run the script below. It fails soft rather than breaking, which is
why the indicator exists at all.

The saved copy gets a 4 second timeout against the network's 12. A local file
that stalls should hand over to the API quickly rather than making me stare at
loading skeletons for twelve seconds first.

### Refreshing it

```bash
python tools/save-catalogue.py                    # catalogue only, 1.67 MB
python tools/save-catalogue.py --covers           # catalogue and any new covers
python tools/save-catalogue.py --dedupe           # tidy covers on disk, no network
python tools/save-catalogue.py --covers --force   # re-download covers I already have
```

Nothing expires and nothing updates itself. Running that script is the entire
update mechanism, which is the point: the data changes when I decide it
changes, not when someone else edits their database. The trade is that my copy
drifts from the archive over time. If a title gets corrected upstream, I keep
the old one until I re-run.

**Covers are real where the archive has them.** 2,073 entries come with their
own art, and anything without real art gets a cover drawn from its title
instead: 8 layouts and 16 colour sets, and the same title always gets the same
one. That generated cover also sits underneath every real image, so a cover
that fails to load does not leave a hole, it just reveals the drawn one.

**Identical covers are stored once.** The archive gives every record its own
cover id even when the image is byte-identical, so the first pass put the same
instrumental placeholder on disk 723 times: 3,879 files holding 1,877 distinct
images, 238 MB where 102 MB would do.

Files are now named after the sha1 of their own bytes, and
`data/covers-index.json` maps each record to its hash. Identical images
collapse to one file and every record that uses it points at the same path.
723 records share a single file now. That also makes a re-run cheap: anything
already in the index is skipped without a request, so only genuinely new
covers get fetched.

```bash
python tools/save-catalogue.py --dedupe     # tidy what is already on disk
```

That one makes no network request at all. It hashes the files I already have,
keeps one copy of each distinct image, and repoints the saved catalogue.

There is no way to spot a duplicate *before* downloading it, so a first run
still pulls all 3,879. The `?v=` hash in the cover URL is per record, so 723
identical images carry 723 different values, and the CDN's ETag encodes upload
time rather than content. Only the bytes tell the truth.

**This is a personal fan project.** It is not published, and it is not
connected to the estate of Jarad Higgins, Grade A Productions or Interscope
Records. Cover images belong to their owners and are here to show which track
is which.

## Run it

Locally is the only way it runs, on `127.0.0.1`, started by hand when I want
it. There is no hosted copy to visit instead.

You need a web server. Double-clicking `index.html` will not work: the browser
blocks JavaScript modules loaded straight off the disk, and you get a blank
page with no obvious reason why.

```bash
python serve.py
```

Then open <http://127.0.0.1:8777>.

`serve.py` is a twenty line wrapper around Python's own `http.server` that
fixes two things it gets wrong here:

- **It sends `Cache-Control: no-store`.** The built in server sends no cache
  headers at all, so browsers hold on to JavaScript heuristically and I end up
  staring at a page I already fixed, debugging a file that is no longer on
  disk. This is the single most confusing failure mode in the project.
- **It forces the JavaScript MIME type.** `http.server` reads it from the
  Windows registry, which on some machines answers `text/plain`. Browsers hard
  refuse ES modules served that way and the page goes blank with no useful
  error.

Plain `python -m http.server 8777 --bind 127.0.0.1` works for a quick look, but
expect the cache to bite the moment I edit anything.

It binds loopback only, on purpose. Nothing here is meant to be reachable from
another machine.

There is nothing to install. No npm, no build step, no config file, no API key.

## How it is built

Plain HTML, CSS and JavaScript modules. No framework, no bundler, no
dependencies.

```text
index.html      home page
vault.html      the archive index
playlists.html  my playlists, saved in the browser
style.css       shared colours, fonts, nav, buttons and the cover art system
home.css        home page styles, layered on style.css
serve.py        the local server, no-cache and loopback only
tribute/        the tribute page, with its own CSS and JS
data/
  catalogue.json    my saved copy of the archive, read before the network
  covers/           cover images, named by hash so identical art is stored
                    once. gitignored
  covers-index.json record id to cover hash. gitignored, rebuildable
  audio/            the songs, if I have pulled them. gitignored
tools/
  README.md          how to download the audio, step by step
  save-catalogue.py  writes the catalogue and the covers
  save-audio.py      downloads the songs
js/
  config.js     settings and constants
  utils.js      small helpers
  api.js        the only file that touches the network, saved copy first
  covers.js     the generated cover art
  db.js         the only file that touches IndexedDB, for playlists
  ui.js         drawing the page
  lightbox.js   the detail panel
  picker.js     the add-to-playlist dialog
  app.js        Vault startup
  home.js       home page startup
  playlists.js  playlists startup
  seed.js       the 39-entry offline sample
```

The data originally comes from `https://api.juicevault.xyz`, which sends an
open CORS header, so the browser can read it directly with no server of my own
in between. That is still where `tools/save-catalogue.py` gets it from. The
pages themselves no longer go there: they read `data/catalogue.json` and only
fall back to that URL if the saved copy has gone missing.
