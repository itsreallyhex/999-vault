#!/usr/bin/env python3
"""Save the archive catalogue to disk so the pages do not need the API.

Writes data/catalogue.json. js/api.js reads that file before it tries the
network, so once this has run the Vault, the landing page and the playlists
page all work with api.juicevault.xyz unreachable, or with no connection at
all. Re-run it whenever you want fresher data; nothing expires on its own.

    python tools/save-catalogue.py              # catalogue only, ~1.65 MB
    python tools/save-catalogue.py --covers     # also pull the cover images
    python tools/save-catalogue.py --dedupe     # tidy covers already on disk
    python tools/save-catalogue.py --covers --force   # re-download every cover

Covers are stored by content, not by record. The archive gives every record
its own cover id even when the image is identical, so naming files after the
record id put the same instrumental placeholder on disk 723 times. Files are
named after the sha1 of their bytes instead, and data/covers-index.json maps
record id to that hash. Identical images collapse to one file and every record
that uses it points at the same path.

That index is also what makes a re-run cheap: a record whose id is already in
it, with its file still present, is skipped without a request. Only genuinely
new covers are fetched. --force ignores the index and re-downloads everything.

There is no way to spot a duplicate before downloading it. The ?v= hash on the
cover URL is per record, so 723 identical images carry 723 different values,
and the CDN's ETag encodes upload time rather than content. Content-Length
does match, but two different images can share a byte count, so it is not safe
on its own. Hashing what arrives is the only exact answer.

A cover that fails to download keeps its CDN path. That degrades the right
way: online it still loads, offline the image simply fails and the generated
cover underneath shows through, which is what covers.js already does.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

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
INDEX = DATA / "covers-index.json"

# Old scheme: <uuid>.webp. New scheme: <sha1>.webp, 40 hex characters.
UUID_NAME = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
                       r"[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
SHA1_NAME = re.compile(r"^[0-9a-f]{40}$")

_index_lock = Lock()


def get(url: str, timeout: float) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def fetch_json(url: str, timeout: float) -> dict:
    return json.loads(get(url, timeout).decode("utf-8"))


def cover_id(path: str) -> str | None:
    """Pull the record's cover id out of a cover path.

    Two shapes reach this. A fresh listing gives /cdn/music/covers/<uuid>?v=,
    where the id is the last segment once the query is dropped. A catalogue
    already rewritten to local gives data/covers/<name>.webp, where the id is
    the last segment *without* the extension. Forgetting the second case makes
    every lookup miss and silently repoints nothing.
    """
    name = urllib.parse.urlparse(path).path.rstrip("/").rsplit("/", 1)[-1]
    if name.endswith(".webp"):
        name = name[:-len(".webp")]
    return name or None


def digest(blob: bytes) -> str:
    return hashlib.sha1(blob).hexdigest()


def local_path(sha: str) -> str:
    """Site-relative path, which is what goes into the catalogue."""
    return f"data/covers/{sha}.webp"


def load_index() -> dict[str, str]:
    if not INDEX.exists():
        return {}
    try:
        data = json.loads(INDEX.read_text(encoding="utf-8"))
        return data.get("by_record", {}) if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}                       # rebuildable, so a bad one is not fatal


def save_index(by_record: dict[str, str]) -> None:
    INDEX.write_text(json.dumps({
        "note": "record id -> sha1 of the cover bytes. Rebuildable: delete it "
                "and re-run with --dedupe.",
        "records": len(by_record),
        "distinct_images": len(set(by_record.values())),
        "by_record": by_record,
    }, indent=1), encoding="utf-8")


def dedupe_local(songs: list[dict]) -> dict:
    """Fold existing <uuid>.webp files into content-addressed ones.

    Touches the network not at all. Every file is hashed, the first copy of
    each distinct image is renamed to its hash and the rest are deleted, and
    the index is rebuilt from what is actually on disk.
    """
    COVERS.mkdir(parents=True, exist_ok=True)
    by_record = load_index()
    tally = {"renamed": 0, "removed": 0, "freed": 0, "already": 0}

    for f in sorted(COVERS.glob("*.webp")):
        stem = f.stem
        if SHA1_NAME.match(stem):
            tally["already"] += 1
            continue
        if not UUID_NAME.match(stem):
            continue                    # not ours, leave it alone

        sha = digest(f.read_bytes())
        dest = COVERS / f"{sha}.webp"
        by_record[stem] = sha

        if dest.exists():
            tally["freed"] += f.stat().st_size
            tally["removed"] += 1
            f.unlink()
        else:
            f.rename(dest)
            tally["renamed"] += 1

    # Point every record at the file its image actually landed in
    rewritten = settled = orphaned = 0
    for s in songs:
        cid = cover_id(s.get("cover") or "")
        if not cid:
            continue
        if cid in by_record:
            s["cover"] = local_path(by_record[cid])
            rewritten += 1
        elif SHA1_NAME.match(cid) and (COVERS / f"{cid}.webp").exists():
            settled += 1                # already content-addressed, nothing to do
        else:
            orphaned += 1               # points at a file that is not there

    save_index(by_record)
    tally["rewritten"] = rewritten
    tally["settled"] = settled
    tally["orphaned"] = orphaned
    tally["distinct"] = len(set(by_record.values()))
    return tally


def grab_cover(song: dict, by_record: dict, timeout: float,
               force: bool) -> tuple[str, bool]:
    """Fetch one cover unless the index already accounts for it."""
    path = song.get("cover")
    if not path:
        return "none", False

    cid = cover_id(path)
    if not cid:
        return "skipped", False

    if not force:
        known = by_record.get(cid)
        if known and (COVERS / f"{known}.webp").exists():
            song["cover"] = local_path(known)
            return "known", True

    try:
        blob = get(API_BASE + path if path.startswith("/") else path, timeout)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        # Keep the CDN path so the record still works online
        return "failed", False

    if not blob:
        return "failed", False

    sha = digest(blob)
    dest = COVERS / f"{sha}.webp"
    with _index_lock:
        by_record[cid] = sha

    song["cover"] = local_path(sha)
    if dest.exists():
        return "shared", True           # fetched, but the bytes were a repeat

    dest.write_bytes(blob)
    return "saved", True


def save_covers(songs: list[dict], timeout: float, force: bool,
                workers: int) -> dict:
    COVERS.mkdir(parents=True, exist_ok=True)
    by_record = load_index()
    tally = {"saved": 0, "shared": 0, "known": 0, "failed": 0,
             "none": 0, "skipped": 0}
    rewritten = 0
    done = 0
    total = sum(1 for s in songs if s.get("cover"))

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(grab_cover, s, by_record, timeout, force)
                   for s in songs]
        for fut in as_completed(futures):
            outcome, rewrote = fut.result()
            tally[outcome] += 1
            rewritten += int(rewrote)
            if outcome in ("saved", "shared", "known", "failed"):
                done += 1
                if done % 250 == 0 or done == total:
                    print(f"  covers {done}/{total}", flush=True)

    save_index(by_record)
    tally["rewritten"] = rewritten
    tally["distinct"] = len(set(by_record.values()))
    return tally


def disk_report() -> str:
    files = list(COVERS.glob("*.webp"))
    total = sum(f.stat().st_size for f in files)
    return f"{len(files)} files, {total / 1_000_000:.0f} MB"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--covers", action="store_true",
                    help="also download the cover images into data/covers/")
    ap.add_argument("--dedupe", action="store_true",
                    help="fold covers already on disk into one file per "
                         "distinct image and rewrite the saved catalogue. "
                         "Makes no network request at all.")
    ap.add_argument("--force", action="store_true",
                    help="ignore the index and re-download every cover")
    ap.add_argument("--workers", type=int, default=8,
                    help="parallel cover downloads (default 8)")
    ap.add_argument("--timeout", type=float, default=30.0,
                    help="per-request timeout in seconds (default 30)")
    args = ap.parse_args()

    DATA.mkdir(parents=True, exist_ok=True)
    out = DATA / "catalogue.json"

    # --dedupe works on what is already saved, so it never asks the archive
    if args.dedupe and not args.covers:
        if not out.exists():
            print("failed: no data/catalogue.json to rewrite", file=sys.stderr)
            return 1
        snapshot = json.loads(out.read_text(encoding="utf-8"))
        songs = snapshot.get("songs") or []
        print(f"before: {disk_report()}", flush=True)

        tally = dedupe_local(songs)
        print(f"  kept {tally['distinct']} distinct images")
        print(f"  renamed {tally['renamed']}, removed {tally['removed']} "
              f"duplicates, freed {tally['freed'] / 1_000_000:.0f} MB")
        print(f"  already content-addressed: {tally['already']}")
        print(f"  records repointed {tally['rewritten']}, "
              f"already correct {tally['settled']}, "
              f"pointing nowhere {tally['orphaned']}")
        if tally["orphaned"]:
            print("  ^ those need --covers to fetch what is missing",
                  file=sys.stderr)

        snapshot["songs"] = songs
        if tally["rewritten"]:
            snapshot["covers"] = "local"
        out.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
        print(f"after:  {disk_report()}")
        return 0

    print(f"GET {LIST_URL}", flush=True)
    started = time.time()
    try:
        payload = fetch_json(LIST_URL, args.timeout)
    except Exception as err:                  # noqa: BLE001 - reported, then we stop
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
        print(f"  downloaded {tally['saved']} new, {tally['shared']} that "
              f"turned out to be repeats, reused {tally['known']} from the "
              f"index, failed {tally['failed']}", flush=True)
        print(f"  {tally['distinct']} distinct images on disk")
        if tally["rewritten"]:
            covers_state = "local"

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
          f"{len(songs)} entries, {size:.2f} MB, covers {covers_state}")
    if args.covers:
        print(f"      {disk_report()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
