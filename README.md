# 999

Listen to a public archive of unreleased songs, 4000+ of them, in one
desktop app.

Search it, play anything, and keep the music going while you look around.
Timed lyrics, a queue, playlists and a record of what you play come with it.

*An unofficial fan project, not affiliated with the estate of Jarad Higgins,
Grade A Productions or Interscope Records. Cover images belong to their
respective owners and are shown to identify recordings.*

![The overview, which the app opens on](Assets/999Startpagedesktop.png)

## Download

Windows only. Get the installer from the
[latest release](https://github.com/itsreallyhex/999-vault/releases/latest),
run it, open the app and play something. There is nothing else to set up:
the catalogue is inside, covers load from the archive and songs stream from
it.

A few seconds after opening, it checks GitHub for a newer version. It asks
before installing anything.

## What it does

- **Find anything.** Search by title or by any of a song's other names, and
  filter by category: main, instrumental, stem, cut, released, remaster,
  acapella, freestyle.
- **Keep listening.** Change pages and the music carries on. Close the app,
  open it again, and you are back on the same song at the same spot.
- **Read along.** A full screen player with the cover, a progress line and
  timed lyrics. Press a line to jump to it.
- **Line things up.** A visible Up next queue, and playlists you can export
  and import.
- **Change the sound.** Slow a song down or speed it up, add reverb or bass,
  use a ten band equalizer, crossfade between songs, set a sleep timer.
- **See what you play.** An overview of plays, time listened, your streak
  and your most played songs.
- **Show it on Discord.** Your status can carry the title, the cover and a
  progress bar. There is a switch in Settings.

![Playing](Assets/DiscordRPC.png) ![Paused](Assets/DiscordRPC(Paused).png)

## Good to know

- A song you have not saved streams from the archive, and the bar says
  `via API`. The arrow on the bar saves it to your archive folder. Reverb,
  bass and the equalizer need a saved song; a streamed one gets speed and
  pitch only.
- Lyrics come from [LRCLIB](https://lrclib.net) by title and artist, once
  per song. A `.lrc` or `.txt` file named like the song works instead.
- Playlists and your history stay on your machine. If you run your own sync
  server, Settings can keep them in step with a second device. It is off
  until you add a server address and a token, and it saves a backup file
  first. The server is a separate project.
- Already have the archive on disk? Choose its folder in Settings and the
  app reads it from there.
- Shortcuts: Space plays and pauses, Left and Right skip, Ctrl with Left or
  Right changes the volume, Escape closes the now playing screen or a panel.

## Privacy

No accounts, no analytics, no telemetry. The app talks to the archive (the
catalogue, covers, streaming and saving songs), to GitHub (the update
check), to LRCLIB (a song title and an artist name, nothing else, only while
the now playing screen is up), to Discord on your machine, and to your own
sync server if you set one up. The update check, the lyrics lookup, the
check for new songs and Discord each have a switch in Settings.

## Build it yourself

```bash
cd desktop
npm install
npx tauri build
```

You need Rust and, on Windows, the Visual Studio *MSVC v143 C++ x64/x86
build tools* and a *Windows 11 SDK*. Run cargo from PowerShell, not Git Bash.
Release builds are signed for the updater with a private key that is not in
this repo, so make your own with `npx tauri signer generate` and set
`TAURI_SIGNING_PRIVATE_KEY`. An app signed with your key will not update from
this project's releases. The pages are read from disk, so editing them needs
no rebuild.

An earlier browser-only version of the Vault lives on the `web` branch. It
is kept as it was and is never merged into `main`.
