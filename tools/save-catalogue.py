#!/usr/bin/env python3
"""Save the archive catalogue to disk so the pages do not need the API.

Writes data/catalogue.json. js/api.js reads that file before it tries the
network, so once this has run the Vault, the landing page and the playlists
page all work with api.juicevault.xyz unreachable, or with no connection at
all. Re-run it whenever you want fresher data; nothing expires on its own.

    python tools/save-catalogue.py              # catalogue only, ~1.6 MB
    python tools/save-catalogue.py --covers     # also pull the cover images
    python tools/save-catalogue.py --covers --force   # re-download every cover

Covers are optional because there are a couple of thousand of them. Without
--covers the saved records keep pointing at the CDN, which means artwork still
needs the network even though the catalogue does not. With --covers the images
land in data/covers/ and each record's `cover` is rewritten to point there.

A cover that fails to download keeps its CDN path. That degrades the right
way: online it still loads, offline the image simply fails and the generated
cover underneath shows through, which is what covers.js already does.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

API_BASE = "https://api.juicevault.xyz"
LIST_URL = f"{API_BASE}/music/list"

# The cover CDN returns 403 to a Python-urllib User-Agent. It answers a
# browser one with or without a Referer, so this is the whole fix.
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

# Resolved from this file, never the working directory: the project folder
# is due to be renamed and a hardcoded path would rot.
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
COVERS = DATA / "covers"


def get(url: str, timeout: float) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def fetch_json(url: str, timeout: float) -> dict:
    return json.loads(get(url, timeout).decode("utf-8"))


def cover_id(path: str) -> str | None:
    """Pull the uuid out of /cdn/music/covers/<uuid>?v=<hash>."""
    name = urllib.parse.urlparse(path).path.rstrip("/").rsplit("/", 1)[-1]
    return name or None


def grab_cover(song: dict, timeout: float, force: bool) -> tuple[str, bool]:
    """Download one cover. Returns (outcome, rewrote) for the tally."""
    path = song.get("cover")
    if not path:
        return "none", False

    cid = cover_id(path)
    if not cid:
        return "skipped", False

    dest = COVERS / f"{cid}.webp"
    local = f"data/covers/{cid}.webp"

    if dest.exists() and not force:
        song["cover"] = local
        return "cached", True

    try:
        blob = get(API_BASE + path if path.startswith("/") else path, timeout)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        # Keep the CDN path so the record still works online
        return "failed", False

    if not blob:
        return "failed", False

    dest.write_bytes(blob)
    song["cover"] = local
    return "saved", True


def save_covers(songs: list[dict], timeout: float, force: bool, workers: int) -> dict:
    COVERS.mkdir(parents=True, exist_ok=True)
    tally = {"saved": 0, "cached": 0, "failed": 0, "none": 0, "skipped": 0}
    rewritten = 0
    done = 0
    total = sum(1 for s in songs if s.get("cover"))

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(grab_cover, s, timeout, force) for s in songs]
        for fut in as_completed(futures):
            outcome, rewrote = fut.result()
            tally[outcome] += 1
            rewritten += int(rewrote)
            if outcome in ("saved", "cached", "failed"):
                done += 1
                if done % 100 == 0 or done == total:
                    print(f"  covers {done}/{total}", flush=True)

    tally["rewritten"] = rewritten
    return tally


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--covers", action="store_true",
                    help="also download the cover images into data/covers/")
    ap.add_argument("--force", action="store_true",
                    help="re-download covers that are already on disk")
    ap.add_argument("--workers", type=int, default=8,
                    help="parallel cover downloads (default 8)")
    ap.add_argument("--timeout", type=float, default=30.0,
                    help="per-request timeout in seconds (default 30)")
    args = ap.parse_args()

    DATA.mkdir(parents=True, exist_ok=True)

    print(f"GET {LIST_URL}", flush=True)
    started = time.time()
    try:
        payload = fetch_json(LIST_URL, args.timeout)
    except Exception as err:                   # noqa: BLE001 - reported, then we stop
        print(f"failed: {err}", file=sys.stderr)
        return 1

    songs = payload.get("songs") or []
    if not songs:
        print("failed: the response carried no songs", file=sys.stderr)
        return 1
    print(f"  {len(songs)} entries in {time.time() - started:.1f}s", flush=True)

    covers_state = "remote"
    if args.covers:
        tally = save_covers(songs, args.timeout, args.force, args.workers)
        print(f"  saved {tally['saved']}, already had {tally['cached']}, "
              f"failed {tally['failed']}, no cover {tally['none']}", flush=True)
        if tally["rewritten"]:
            covers_state = "local"

    out = DATA / "catalogue.json"
    snapshot = {
        "saved_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": LIST_URL,
        "count": len(songs),
        "covers": covers_state,
        "songs": songs,
    }
    out.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")

    size = out.stat().st_size / 1_000_000
    print(f"wrote {out.relative_to(ROOT).as_posix()}  "
          f"{len(songs)} entries, {size:.1f} MB, covers {covers_state}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
