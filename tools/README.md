# How to get the songs

The archive serves the audio. Getting it takes about half an hour, not days,
but only if you log in first. Without logging in you get 500 files a day and
the set takes six days.

This page is the short version. Follow it top to bottom.

---

## What you get

2,662 songs, 25.8 GB. That is main, stem and remaster.

Skipping instrumental, cut and released saves 24 GB. Instrumentals alone are
20.6 GB. Take everything and it is 3,879 songs and 50 GB.

---

## Before you start

You need:

- An account on juicevault.xyz, signed in, on a desktop browser.
- 26 GB free.
- The catalogue saved already. If `data/catalogue.json` is missing, run this
  first:

```bash
python tools/save-catalogue.py
```

---

## Step 1: copy your token

The API has no login route, so the script cannot sign in for you. You copy the
token your browser is already using.

1. Open **juicevault.xyz** on a computer and sign in.
2. Press **F12** to open developer tools.
3. Click the **Network** tab.
4. Download any song on the site. One click, any track.
5. In the list of requests, click the one that says **download**.
6. Right click it, choose **Copy**, then **Copy as cURL**.

You now have a wall of text on your clipboard. Somewhere inside it is a line
starting with `authorization: Bearer` and then a very long string of
letters and numbers. That long string is the token.

**The token lasts 15 minutes.** Do the next step immediately. If you make tea
first you will have five minutes left and the download will stop halfway.

---

## Step 2: paste it into .env

Open `.env` in the project folder. Add one line:

```text
JUICEVAULT_AUTH=Bearer PASTE_THE_LONG_STRING_HERE
```

Paste your own token after the word `Bearer`. Keep it on one line.

`.env` is gitignored, so the token will not end up in a commit. Treat it like a
password, because it is one. Anyone holding it is you, for 15 minutes.

---

## Step 3: check it worked

```bash
python tools/save-audio.py --check
```

You want to see this:

```text
token expires in 14.2 min, so this run will stop after roughly 1886 files
credential in .env: yes
tier verified, 5000 of 5000 left, resets ...
```

Two things to read:

**`tier verified`** means the token is working. If it says `tier anonymous`,
the token is wrong or already expired. Go back to step 1 and be quicker.

**`expires in 14.2 min`** is your budget. Fourteen minutes buys about 1,800
songs. Under five minutes, get a fresh token instead of starting.

---

## Step 4: download

```bash
python tools/save-audio.py --only main,stem,remaster --out E:/999-audio
```

Change `--out` to wherever you want the files. Leave it off and they go to
`data/audio`, which works but puts 26 GB next to the git repo.

It prints progress as it goes:

```text
  250/2662  2.43 GB  21.3 MB/s
```

About 130 songs a minute.

---

## Step 5: run it again

One token will not finish the job. 2,662 songs need roughly 20 minutes and a
token dies after 15.

When it stops it tells you why:

```text
the token expired (they last 15 minutes). Copy a fresh one from devtools
into .env and re-run: everything already saved is skipped, so it carries
on where it stopped.
```

Get a new token, replace the `JUICEVAULT_AUTH=` line, run the same command
again. Files already on disk are skipped instantly, so nothing is wasted and
nothing downloads twice.

Two tokens is normal. Three if you are slow copying them.

---

## When it is finished

```text
have 2662  saved 0
on disk: 2662 tracks, 25.78 GB
```

`have` is the count it skipped because they were already there. When `have`
equals your target and `saved` is 0, you are done.

---

## If something goes wrong

**`tier anonymous` when you have a token.** Expired, or you copied the wrong
request. The token has to come from a **download** request, not from playing a
song. Playback needs no login, so those requests carry no token.

**It stopped early and says the allowance ran out.** You hit the 500-a-day
anonymous limit, which means the token lapsed mid-run and the script fell back
to anonymous without you noticing. It now stops before the token expires
instead. Wait for the reset time it prints, or use a fresh token.

**A few songs always fail.** Three tracks return a server error from the
download endpoint, because their filenames contain characters the server cannot
put in a header: a curly apostrophe, or an invisible space at the start of the
name. The script retries those through the streaming endpoint, which works.
Nothing for you to do.

**Downloads are slow.** 20 MB/s is normal. Raising `--workers` above 4 mostly
loads the archive harder without helping you much, so leave it alone.

---

## Other things it can do

```bash
# see what would download, without downloading
python tools/save-audio.py --only main,stem,remaster --dry-run

# grab five, to check it works before committing to 26 GB
python tools/save-audio.py --only main,stem,remaster --limit 5

# everything, all 3,879 songs, 50 GB
python tools/save-audio.py
```

---

## One request

This is somebody's archive and they pay for the bandwidth. The limits are
published and generous, and the tool stays inside them. Leave `--workers` at 4,
do not use `--force` unless you need to, and do not download the whole thing
twice because you forgot where you put it the first time.
