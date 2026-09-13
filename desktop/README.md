# 999, desktop

A Tauri 2 app over the same archive the site reads. A listening overview,
the Vault, the playlists, a player that keeps going between them, and
Discord Rich Presence.

![The overview, which the app opens on](../Assets/999Startpagedesktop.png)

## Run it

```bash
cd desktop
npm install
npx tauri build
```

That makes `src-tauri/target/release/vault999.exe` and two installers under
`src-tauri/target/release/bundle/` (NSIS and MSI, both `999 Vault_0.1.0`).
Run any of them. `npm run dev` is only for working on the Rust side.

After a change to the Rust side, `npm run fresh` closes the running app,
builds, and opens the new one. With Claude Code you do not even type that:
a Stop hook in `.claude/settings.json` runs it at the end of any turn that
touched `src-tauri/`, in the background, and prunes old installers when it
is done. The log is `src-tauri/target/auto-fresh.log`.

Needs Rust plus, on Windows, two Visual Studio components: *MSVC v143 - VS
2022 C++ x64/x86 build tools* and a *Windows 11 SDK*. Run cargo from
PowerShell, not Git Bash: Git's own `link.exe` shadows the MSVC linker.

**Editing the pages needs no rebuild, and no reload either.** They are
read off disk at runtime, and when they come from a checkout the app
watches the folder: save a stylesheet and it is swapped in place with the
music still playing, save a page and the frame reloads, save `player.js` or
`shell.js` and the whole window reloads. **Ctrl+R** / **F5** and
**Ctrl+Shift+R** still do the same by hand.

## Point it at the archive

**With nothing on the machine, it works anyway.** The installer carries the
catalogue (the whole app is under 3 MB), so on first run the app writes it
to its own data folder and opens with all 3,879 records. Covers come from
the archive's CDN and songs stream from it. Install, open, listen.

With the archive on disk it reads that instead: the same `web/data` folder
the site uses, covers and audio included. A dev build inside the checkout
finds it on its own. Anything else is told where to look, first hit
winning:

1. `NINE_DATA_ROOT` in the environment.
2. `data_root` in the config file.
3. A `data` folder beside the exe.
4. A `data` folder in the OS app data directory.
5. `web/data` in a checkout above the exe.

The Settings page sets the folder for you. The same value can be typed
into `%APPDATA%\xyz.juicevault.nine\config.toml`, written as a commented
template on first run, with forward slashes and single quotes:

```toml
data_root = 'D:/Random coding/999-vault/web/data'
pages_dir = 'D:/Random coding/999-vault/desktop/src'
```

The app prints what it resolved, and which rule answered, on startup. The
Settings page shows the same.

## What it does

**The overview** is the opening page: a greeting, total plays, time
listened, streak, unique songs, the eight most played tracks (click one to
play it), how much of the 2,073 main tracks you have played, plays by hour,
and the last two weeks. All of it comes from a listening history the player
writes as you go. It starts empty.

**The Vault and the playlists** are the site's, with two additions. The
playing track is marked on its row and card, and a track you never pulled to
disk streams from the archive instead of refusing; the bar says `via API`
while it does. Next prefers files on disk and streams only when the current
filter has none. One click on a Vault card opens the detail panel, two play
it.

**The sidebar** on the left is how you move between the pages, with
Settings at the bottom. It lives outside the pages
with the player, so it never reloads.

**The player** lives outside the pages, so switching tabs does not stop the
music. Close the app and open it again and the bar comes back on the
track you were on, at the same position, paused: press play to carry on.
Three things on the bar reach past it: pressing the artwork opens
the track in the Vault, with its alternate titles and the rest; the plus
adds it to a playlist; the arrow saves a streamed track to the archive
folder, through the archive's metered download (500 a day for anyone
without an account), so the next play comes off disk. The arrow only
shows for a track that is not on this machine yet.

**Settings**, from the sidebar, for the things a person would otherwise have to
edit in a file: whether songs come from the files on this machine first or
from the archive first (local first is the default; stream first plays from
the archive and falls back to the file if the archive fails), whether
Discord is told what is playing, and which folder the archive is in, with a
folder picker. Changes save as you make them. A folder change is picked up
the next time the app opens.

**Discord** shows what is playing while the app is open and Discord is
running. Three states:

Playing: title, "Juice WRLD", cover, progress bar.

![Playing](../Assets/DiscordRPC.png)

Repeat-one on: the second line says "On repeat".

![Repeat-one on](../Assets/DiscordRPC(On-Repeat).png)

Paused: "Paused" and a timer counting up from the pause.

![Paused](../Assets/DiscordRPC(Paused).png)

Stopping, or a track ending, clears it. The cover comes from the archive's
CDN because Discord fetches it from its own servers. Turn it off in
Settings.

## Files

```text
src/
  shell.html      The window. Holds the sidebar and the player; shows the
                  pages in a frame.
  index.html      The overview.
  vault.html
  playlists.html
  settings.html
  js/tauri.js     The only module that talks to Rust.
  js/player.js    The only module that owns an audio element.
src-tauri/src/
  paths.rs        Every path, resolved at runtime.
  data.rs         The archive folder and its JSON indexes.
  pages.rs        Serves src/ off disk.
  presence.rs     Discord.
  settings.rs     Reads and writes the settings in config.toml.
  tools.rs        Runs the Python scripts in web/tools.
```

Nothing here imports from `web/`. Shared modules are copies and have
diverged.

## Not done

- **Songs stream by default.** A fresh install holds no audio; every play
  comes from the archive over the network until you save it. Saving is
  one track at a time, from the arrow on the bar, and counts against the
  archive's 500 downloads a day. There is no bulk download in the app; the
  whole archive is still `save-audio.py`, which needs Python and a token.
- The catalogue a fresh install starts from is the one the installer was
  built with. Refreshing it still needs `sync.py`, which needs Python.
- The audio index loads once per launch. Run `save-audio.py` with the app
  closed, or restart it.
- `run_tool` can run the Python scripts but nothing in the interface calls
  it. Python has to be on PATH.
