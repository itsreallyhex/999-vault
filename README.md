# 999

A fan-made site about the Juice WRLD archive. It has three pages: a home page,
a searchable index of the archive called the Vault, and a tribute page.

It does not play music. It shows the details of each track and the cover art,
and that is all.

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

**There is no audio anywhere.** The archive API can hand out MP3 and WAV files,
but this site never asks for them. No player, no download links, nothing that
points at an audio file. That was the rule the whole thing was built around.

**The numbers are live.** The Vault asks the archive for its list every time you
open it, so the counts you see are whatever the archive holds right now, not a
number someone typed in. If that request fails or takes too long, the page
falls back to a small sample of 39 entries that ships with the site, and says
"Offline sample" at the top so you know.

**Covers are real where the archive has them.** 2,073 entries come with their
own art. The rest share one grey placeholder per type, which looks repetitive
very fast, so anything without real art gets a cover drawn from its title
instead. There are 8 layouts and 16 colour sets. The same title always gets the
same cover.

**This is a fan project.** It is not connected to the estate of Jarad Higgins,
Grade A Productions or Interscope Records. Cover images belong to their owners
and are here to show which track is which.

## Run it locally

You need a web server. Double-clicking `index.html` will not work: the browser
blocks JavaScript modules loaded straight off the disk, and you get a blank
page with no obvious reason why.

If you have Python, that is enough:

```bash
cd path/to/the/project
python -m http.server 8777 --bind 127.0.0.1
```

Then open <http://127.0.0.1:8777> in your browser.

That works fine for a look around. If you plan to edit anything, use this
instead. Python's built-in server sends no cache headers, so browsers hang onto
old JavaScript files, and you end up staring at a broken page that you already
fixed:

```python
# serve.py
import http.server, socketserver, os

os.chdir(os.path.dirname(os.path.abspath(__file__)))

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        super().end_headers()

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", 8777), H) as s:
    s.serve_forever()
```

Save that next to `index.html` and run `python serve.py`.

There is nothing to install. No npm, no build step, no config file, no API key.

## How it is built

Plain HTML, CSS and JavaScript modules. No framework, no bundler, no
dependencies.

```text
index.html      home page
vault.html      the archive index
style.css       shared colours, fonts, nav, buttons and the cover art system
home.css        home page styles, layered on style.css
tribute/        the tribute page, with its own CSS and JS
js/
  config.js     settings and constants
  utils.js      small helpers
  api.js        the only file that touches the network
  covers.js     the generated cover art
  ui.js         drawing the page
  lightbox.js   the detail panel
  app.js        Vault startup
  home.js       home page startup
  seed.js       the 39-entry offline sample
```

The data comes from `https://api.juicevault.xyz`. It sends an open CORS header,
so the browser can read it directly with no server of your own in between.
