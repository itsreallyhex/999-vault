#!/usr/bin/env python3
"""Pick up whatever the archive has added since the last snapshot.

    python tools/sync.py              # show what moved, ask, then fetch it
    python tools/sync.py --check      # show what moved and stop
    python tools/sync.py --yes        # do not ask

The catalogue in data/ is a point in time and nothing refreshes it on its own.
This compares it against the live listing, reports what moved, and pulls down
the difference: audio for new main, stem and remaster records, covers that are
genuinely new, and a rewritten catalogue so the Vault lists everything.

It is the incremental half of save-catalogue.py and save-audio.py, and it
calls into both rather than repeating them. The awkward parts, verifying a
download against the response's Content-Length, working around the three
records whose /download endpoint answers 5xx, stopping before a bearer token
expires, folding byte-identical covers onto one file, all live over there and
are not worth a second implementation that can drift.

Three things worth knowing.

**It matches records on `id`, never by comparing whole records.** Measured on
this catalogue: `cover` differs on all 3,879, because a saved snapshot rewrites
that field to data/covers/<sha1>.webp while the API returns /cdn/..., and
play_count moved on 1,138 of them in nine hours. A record-equality diff flags
the whole catalogue as changed and tells you nothing.

**It usually needs no token.** The 15 minute bearer token in tools/README.md
exists because the first pull was 2,662 files and wanted the verified tier. A
handful of new songs fits inside the anonymous allowance of 500 a day, so a
normal run needs no login. If .env holds a working token it gets used, and the
same expiry guard applies.

**The category filter applies to the audio, not to the catalogue.** Every new
record is saved to catalogue.json whatever its category, or the Vault would
quietly lose entries from its index. Only main, stem and remaster get their
audio fetched, which is the same set the first pull took.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
DATA = ROOT / "data"
CATALOGUE = DATA / "catalogue.json"

#: Categories whose audio is worth having. The rest are catalogued but not
#: downloaded: instrumentals alone are 20.62 GB.
DEFAULT_ONLY = "main,stem,remaster"

#: Fields that move on their own and say nothing about a record changing.
#: `cover` is rewritten locally by a --covers save; play_count is a counter.
VOLATILE = {"cover", "play_count"}


def _load(name: str, filename: str):
    """Import a sibling script whose filename carries a hyphen.

    `save-audio.py` is not a legal module name, so a plain import cannot
    reach it. Both scripts guard their entry point with __name__, so
    executing them here defines their functions and runs nothing.
    """
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


cat = _load("save_catalogue", "save-catalogue.py")
aud = _load("save_audio", "save-audio.py")


# ---------- Comparing ----------

def compare(live: list[dict], saved: list[dict]) -> tuple[list, list, list]:
    """(added, removed, edited), matched on id.

    `edited` carries the field names that actually differ, so a retitle can
    be told from an archive that merely recounted the plays.
    """
    was = {s["id"]: s for s in saved if s.get("id")}
    now = {s["id"]: s for s in live if s.get("id")}

    added = [s for s in live if s.get("id") and s["id"] not in was]
    removed = [s for s in saved if s.get("id") and s["id"] not in now]

    edited = []
    for song in live:
        before = was.get(song.get("id"))
        if not before:
            continue
        fields = sorted(
            k for k in set(song) | set(before)
            if k not in VOLATILE and song.get(k) != before.get(k)
        )
        if fields:
            edited.append((song, before, fields))

    return added, removed, edited


def describe(song: dict) -> str:
    size = song.get("file_size") or "?"
    when = (song.get("archive_added_at") or "")[:10]
    return (f"  {song.get('category', '?'):12} "
            f"{(song.get('title') or '?')[:52]:54} {size:>9}  {when}")


def report(added, removed, edited, want: set[str]) -> None:
    if added:
        fetchable = [s for s in added if (s.get("category") or "").lower() in want]
        gb = sum(s.get("file_size_bytes") or 0 for s in fetchable) / 1e9
        print(f"\n{len(added)} new record(s):")
        for song in sorted(added, key=lambda s: (s.get("category") or "",
                                                 s.get("title") or "")):
            print(describe(song))
        print(f"\n  {len(fetchable)} of them are {'/'.join(sorted(want))}, "
              f"{gb:.2f} GB of audio")
        if len(fetchable) != len(added):
            print(f"  the other {len(added) - len(fetchable)} get catalogued "
                  f"but not downloaded")

    if removed:
        print(f"\n{len(removed)} record(s) no longer in the listing:")
        for song in removed[:10]:
            print(describe(song))
        if len(removed) > 10:
            print(f"  ... and {len(removed) - 10} more")
        print("  their files stay on disk. Nothing here deletes audio.")

    if edited:
        retitled = [e for e in edited if "title" in e[2] or "alt_names" in e[2]]
        print(f"\n{len(edited)} record(s) edited upstream, "
              f"{len(retitled)} of them a title or an alternate name:")
        for song, before, fields in edited[:10]:
            print(f"  {(before.get('title') or '?')[:44]:46} -> "
                  f"{', '.join(fields)}")
        if len(edited) > 10:
            print(f"  ... and {len(edited) - 10} more")


# ---------- Fetching ----------

def fetch_audio(songs: list[dict], out: Path, timeout: float,
                workers: int) -> dict:
    """Download audio for these records, reusing save-audio.py wholesale."""
    out.mkdir(parents=True, exist_ok=True)
    by_id = aud.load_index()
    tally: dict[str, int] = {}
    got = done = 0
    started = time.time()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(aud.fetch_one, s, out, by_id, timeout, False)
                   for s in songs]
        try:
            for fut in as_completed(futures):
                outcome, n = fut.result()
                tally[outcome] = tally.get(outcome, 0) + 1
                got += n
                done += 1
                rate = got / max(1e-9, time.time() - started) / 1e6
                print(f"  {done}/{len(songs)}  {got/1e9:.2f} GB  {rate:.1f} MB/s",
                      flush=True)
        except KeyboardInterrupt:
            aud._stop = True
            print("\nstopping, finishing what is in flight", file=sys.stderr)

    # The three records whose /download answers 5xx are marked during the
    # pass above and take the /stream path, which is not broken for them.
    retry = [s for s in songs if s["id"] in aud._broken and s["id"] not in by_id]
    if retry:
        print(f"  {len(retry)} record(s) the download endpoint errored on, "
              f"retrying via stream")
        for song in retry:
            outcome, n = aud.fetch_one(song, out, by_id, timeout, False)
            tally[outcome] = tally.get(outcome, 0) + 1
            got += n

    aud.save_index(by_id)
    return tally


def write_catalogue(live: list[dict], timeout: float, workers: int) -> str:
    """Fold the covers in and write the snapshot.

    save_covers runs over the whole listing, not just the new records. That
    is deliberate and costs almost nothing: a record already in the cover
    index whose file is still on disk is rewritten to its local path with no
    request at all. It is how the other 3,879 keep pointing at data/covers/
    instead of reverting to the CDN paths the live listing carries.
    """
    tally = cat.save_covers(live, timeout, False, workers)
    print(f"  covers: {tally['saved']} new, {tally['shared']} repeats, "
          f"{tally['known']} already held, {tally['failed']} failed")

    state = "local" if tally["rewritten"] else "remote"
    CATALOGUE.write_text(json.dumps({
        "saved_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": cat.LIST_URL,
        "count": len(live),
        "covers": state,
        "songs": live,
    }, ensure_ascii=False), encoding="utf-8")
    return state


def confirm(question: str) -> bool:
    try:
        return input(f"{question} [y/N] ").strip().lower() in ("y", "yes")
    except EOFError:
        # Piped or non-interactive: take the answer that changes nothing
        print("not a terminal, so nothing was changed. Use --yes to proceed.",
              file=sys.stderr)
        return False


# ---------- Entry point ----------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--check", action="store_true",
                    help="report what moved and stop, changing nothing")
    ap.add_argument("--yes", action="store_true",
                    help="do not ask before downloading")
    ap.add_argument("--only", default=DEFAULT_ONLY,
                    help=f"categories whose audio to fetch "
                         f"(default {DEFAULT_ONLY})")
    ap.add_argument("--out", default=str(DATA / "audio"),
                    help="where audio goes (default data/audio)")
    ap.add_argument("--no-audio", action="store_true",
                    help="refresh the catalogue and covers, fetch no audio")
    ap.add_argument("--workers", type=int, default=4,
                    help="parallel downloads (default 4, please be gentle)")
    ap.add_argument("--timeout", type=float, default=120.0,
                    help="per-file timeout in seconds (default 120)")
    args = ap.parse_args()

    if not CATALOGUE.exists():
        print("failed: no data/catalogue.json to compare against. "
              "Run save-catalogue.py first.", file=sys.stderr)
        return 1

    saved_doc = json.loads(CATALOGUE.read_text(encoding="utf-8"))
    saved = saved_doc.get("songs") or []
    print(f"saved:  {len(saved)} records, taken "
          f"{(saved_doc.get('saved_at') or '?')[:19]}")

    print(f"GET {cat.LIST_URL}", flush=True)
    started = time.time()
    try:
        live = cat.fetch_json(cat.LIST_URL, 30.0).get("songs") or []
    except Exception as err:                  # noqa: BLE001 - reported, then stop
        print(f"failed: {err}", file=sys.stderr)
        return 1
    if not live:
        print("failed: the response carried no songs", file=sys.stderr)
        return 1
    print(f"live:   {len(live)} records in {time.time() - started:.1f}s")

    want = {c.strip().lower() for c in args.only.split(",") if c.strip()}
    added, removed, edited = compare(live, saved)

    if not (added or removed or edited):
        print("\nnothing has changed upstream.")
        return 0

    report(added, removed, edited, want)

    if args.check:
        return 0

    fetchable = [] if args.no_audio else [
        s for s in added
        if (s.get("category") or "").lower() in want and s.get("id")
    ]

    # Nothing new to download is still worth a catalogue rewrite: a title
    # corrected upstream is drift the saved snapshot otherwise keeps forever.
    question = (f"\nfetch {len(fetchable)} track(s) and refresh the catalogue?"
                if fetchable else "\nrefresh the catalogue with these edits?")
    if not (args.yes or confirm(question)):
        print("nothing was changed.")
        return 0

    if fetchable:
        aud._deadline = aud.token_expiry()
        tier = aud.allowance().get("tier", "?")
        left = (aud._deadline - time.time()) / 60 if aud._deadline else 0
        print(f"\ntier {tier}" + (f", token good for {left:.0f} min" if aud._deadline
                                  else ", no token, which is fine for a few files"))

        tally = fetch_audio(fetchable, Path(args.out), args.timeout, args.workers)
        print("  " + "  ".join(f"{k} {v}" for k, v in sorted(tally.items())))
        if tally.get("limited"):
            print("the allowance ran out. Re-run later to pick up the rest.",
                  file=sys.stderr)
        if tally.get("expired"):
            print("the token expired. Copy a fresh one into .env and re-run: "
                  "anything already saved is skipped.", file=sys.stderr)

    print("\nwriting the catalogue")
    state = write_catalogue(live, 30.0, args.workers)
    size = CATALOGUE.stat().st_size / 1_000_000
    print(f"wrote data/catalogue.json  {len(live)} entries, {size:.2f} MB, "
          f"covers {state}")
    print("\nReload the browser: an open page is still holding the old copy.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
