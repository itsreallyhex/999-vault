#!/usr/bin/env python3
"""Download audio from the archive, for the categories you actually want.

The archive does serve audio, despite the listing carrying no URL for it:

    GET /music/stream/{id}     audio/mpeg
    GET /music/download/{id}   audio/mpeg

Both return Content-Length equal to the record's file_size_bytes. The full
catalogue is about 50 GB; main + stem + remaster is 25.8 GB over 2,662 tracks.

    python tools/save-audio.py --check                    # auth and allowance
    python tools/save-audio.py --only main,stem,remaster --dry-run
    python tools/save-audio.py --only main,stem,remaster --out E:/999-audio

Downloads are metered per account, and the tiers are published at
/music/download-limit: anonymous 500 per 24h, unverified 1500 per 6h,
verified 5000 per 2h. Anonymous is the default for an unauthenticated
request, so without a credential a 2,662 track pull takes six days instead
of one session. --check tells you which tier you are actually getting.

CREDENTIAL. The API documents no login route, so this cannot sign in for
you. Copy the header your browser already sends: open juicevault.xyz, open
devtools, Network, click any request to api.juicevault.xyz and copy its
Authorization or Cookie header. Put one of these in .env, which is
gitignored:

    JUICEVAULT_AUTH=Bearer <the long string from that header>
    JUICEVAULT_COOKIE=session=abc123; other=value

Treat it like a password: it is one. It is never written to disk by this
script and never printed. It will expire, and --check will say so by
reporting the anonymous tier again.

BE A DECENT GUEST. This is one person's archive and 25.8 GB is a real cost
to whoever pays for the bandwidth. The default of 4 workers is deliberately
modest. Do not raise it much, and do not re-run with --force unless you
actually need to.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock

API_BASE = "https://api.juicevault.xyz"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CATALOGUE = DATA / "catalogue.json"
INDEX = DATA / "audio-index.json"

_lock = Lock()
_stop = False            # set when the allowance runs out, to stop politely
_deadline = 0.0          # unix time the bearer token stops being accepted
_broken: set[str] = set()   # ids whose /download 500s, retried via /stream


def token_expiry() -> float:
    """When the bearer token in .env expires, as unix time. 0 if unknown.

    This matters more than it looks. When the token lapses the API does not
    answer 401: it silently treats the request as anonymous and starts
    spending the 500-a-day anonymous allowance instead. A run that ignores
    expiry therefore burns a whole day's quota without ever seeing an error.
    So read `exp` out of the JWT and stop before it lands.
    """
    auth = credential().get("Authorization", "")
    parts = auth.replace("Bearer ", "", 1).split(".")
    if len(parts) != 3:
        return 0.0
    try:
        pad = parts[1] + "=" * (-len(parts[1]) % 4)
        return float(json.loads(base64.urlsafe_b64decode(pad)).get("exp", 0))
    except Exception:                          # noqa: BLE001 - not worth failing on
        return 0.0


def credential() -> dict[str, str]:
    """Auth header from the environment or .env. Never logged."""
    env = {}
    dotenv = ROOT / ".env"
    if dotenv.exists():
        for line in dotenv.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")

    auth = os.environ.get("JUICEVAULT_AUTH") or env.get("JUICEVAULT_AUTH")
    cookie = os.environ.get("JUICEVAULT_COOKIE") or env.get("JUICEVAULT_COOKIE")
    if auth:
        return {"Authorization": auth if " " in auth else f"Bearer {auth}"}
    if cookie:
        return {"Cookie": cookie}
    return {}


def headers(extra: dict | None = None) -> dict[str, str]:
    h = {"User-Agent": UA, "Accept": "*/*"}
    h.update(credential())
    h.update(extra or {})
    return h


def get_json(path: str, timeout: float = 30.0) -> dict:
    req = urllib.request.Request(API_BASE + path, headers=headers())
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))


def allowance() -> dict:
    try:
        return get_json("/music/download-limit")
    except Exception as err:                  # noqa: BLE001
        return {"error": str(err)}


def load_index() -> dict:
    if not INDEX.exists():
        return {}
    try:
        d = json.loads(INDEX.read_text(encoding="utf-8"))
        return d.get("by_id", {}) if isinstance(d, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def save_index(by_id: dict) -> None:
    INDEX.write_text(json.dumps({
        "note": "song id -> saved audio file. Rebuildable by re-running; "
                "files already on disk with the right size are not refetched.",
        "tracks": len(by_id),
        "bytes": sum(v.get("bytes", 0) for v in by_id.values()),
        "by_id": by_id,
    }, indent=1), encoding="utf-8")


def safe_name(song: dict) -> str:
    """<title> [<id8>].<ext>, cleaned for Windows, falling back to the id."""
    ext = Path(song.get("file_name") or "").suffix.lower() or ".mp3"
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", song.get("title") or "").strip(" .")
    stem = re.sub(r"\s+", " ", stem)[:120] or song["id"]
    return f"{stem} [{song['id'][:8]}]{ext}"


def fetch_one(song: dict, out: Path, by_id: dict, timeout: float,
              force: bool) -> tuple[str, int]:
    global _stop
    if _stop:
        return "stopped", 0

    # Stop while the token is still good. Past expiry the API answers as
    # anonymous rather than refusing, and would eat the daily quota silently.
    if _deadline and time.time() > _deadline - 20:
        with _lock:
            _stop = True
        return "expired", 0

    sid = song["id"]
    want = song.get("file_size_bytes") or 0
    known = by_id.get(sid, {})
    name = known.get("file") or safe_name(song)
    dest = out / name

    # Already here? Trust the byte count recorded on the way in. For a file
    # with no index entry, allow a little slack against the catalogue figure:
    # the archive serves a few dozen bytes less than it lists, because the tags
    # on the delivered file are not the ones it measured.
    if not force and dest.exists():
        have = dest.stat().st_size
        if (known.get("bytes") == have) or (want and abs(have - want) <= 4096):
            with _lock:
                by_id[sid] = {"file": name, "bytes": have}
            return "have", 0

    part = dest.with_suffix(dest.suffix + ".part")
    url = f"{API_BASE}/music/download/{sid}"
    if sid in _broken:
        # /music/download 500s on a handful of records whose file_name carries
        # characters a Content-Disposition header cannot hold: a curly
        # apostrophe, a leading zero-width space. /music/stream serves the same
        # bytes and sets no such header. This is a fallback for a broken
        # endpoint, not a way around the allowance: it only ever runs after
        # /download has answered 5xx for this exact id.
        url = f"{API_BASE}/music/stream/{sid}"
    try:
        req = urllib.request.Request(url, headers=headers())
        with urllib.request.urlopen(req, timeout=timeout) as res, \
                part.open("wb") as fh:
            # Verify against what the server says it is sending, never against
            # the catalogue. Those disagree by around a hundred bytes on many
            # tracks, and comparing to the catalogue throws good files away.
            declared = int(res.headers.get("Content-Length") or 0)
            got = 0
            while True:
                chunk = res.read(1 << 16)
                if not chunk:
                    break
                fh.write(chunk)
                got += len(chunk)
    except urllib.error.HTTPError as e:
        part.unlink(missing_ok=True)
        if e.code == 429:                     # allowance gone, stop the run
            with _lock:
                _stop = True
            return "limited", 0
        if 500 <= e.code < 600 and sid not in _broken:
            # Broken on their side for this record. Mark it and let the caller
            # come round again, which will take the /stream path above.
            with _lock:
                _broken.add(sid)
            return "retry", 0
        if e.code in (401, 403):
            # The bearer token lives 15 minutes. Stop at the first rejection
            # rather than grinding through thousands of files that will all
            # fail the same way; a fresh token and a re-run picks up here.
            with _lock:
                _stop = True
            return "expired", 0
        return "failed", 0
    except (urllib.error.URLError, TimeoutError, OSError):
        part.unlink(missing_ok=True)
        return "failed", 0

    if declared and got != declared:          # genuinely truncated, keep nothing
        part.unlink(missing_ok=True)
        return "short", 0

    part.replace(dest)
    with _lock:
        by_id[sid] = {"file": name, "bytes": got}
    return "saved", got


def main() -> int:
    global _stop
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--only", default="",
                    help="comma separated categories, e.g. main,stem,remaster")
    ap.add_argument("--out", default=str(DATA / "audio"),
                    help="where the files go (default data/audio). Point this "
                         "at another drive for the full set.")
    ap.add_argument("--check", action="store_true",
                    help="report the tier and allowance, then exit")
    ap.add_argument("--dry-run", action="store_true",
                    help="list what would be fetched and how big, fetch nothing")
    ap.add_argument("--limit", type=int, default=0,
                    help="stop after this many files (0 = no cap)")
    ap.add_argument("--force", action="store_true",
                    help="re-download even if the file is already correct")
    ap.add_argument("--workers", type=int, default=4,
                    help="parallel downloads (default 4, please be gentle)")
    ap.add_argument("--timeout", type=float, default=120.0,
                    help="per-file timeout in seconds (default 120)")
    args = ap.parse_args()

    global _deadline
    have_cred = bool(credential())
    _deadline = token_expiry()
    a = allowance()
    tier = a.get("tier", "?")
    if _deadline:
        left = _deadline - time.time()
        print(f"token expires in {left/60:.1f} min"
              + ("  <- already expired, refresh it" if left <= 0 else
                 f", so this run will stop after roughly "
                 f"{int(max(0, left) * 2.2)} files"))
    print(f"credential in .env: {'yes' if have_cred else 'NO'}")
    print(f"tier {tier}, {a.get('remaining','?')} of {a.get('max','?')} left, "
          f"resets {a.get('resetsAt','?')}")
    if have_cred and tier == "anonymous":
        print("  the credential is not being accepted: expired, or the wrong "
              "header. Re-copy it from devtools.", file=sys.stderr)
    if not have_cred:
        print("  without a credential you get the anonymous tier. See the "
              "docstring at the top of this file.", file=sys.stderr)
    if args.check:
        return 0

    if not CATALOGUE.exists():
        print("failed: no data/catalogue.json. Run save-catalogue.py first.",
              file=sys.stderr)
        return 1
    songs = json.loads(CATALOGUE.read_text(encoding="utf-8")).get("songs") or []

    if args.only:
        want = {c.strip().lower() for c in args.only.split(",") if c.strip()}
        songs = [s for s in songs if (s.get("category") or "").lower() in want]
    songs = [s for s in songs if s.get("id")]
    if args.limit:
        songs = songs[:args.limit]

    total = sum(s.get("file_size_bytes") or 0 for s in songs)
    out = Path(args.out)
    by_id = load_index()

    print(f"\n{len(songs)} tracks, {total/1e9:.2f} GB -> {out}")
    remaining = a.get("remaining")
    if isinstance(remaining, int) and len(songs) > remaining:
        print(f"  note: {len(songs)} files but only {remaining} left in this "
              f"window. It will stop when the allowance runs out; re-run after "
              f"{a.get('resetsAt','the reset')} to continue.")
    if args.dry_run:
        for s in songs[:5]:
            print(f"    {safe_name(s)}  {(s.get('file_size_bytes') or 0)/1e6:.1f} MB")
        print(f"    ... and {max(0, len(songs)-5)} more")
        return 0

    out.mkdir(parents=True, exist_ok=True)
    tally: dict[str, int] = {}
    got_bytes = done = 0
    started = time.time()

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(fetch_one, s, out, by_id, args.timeout, args.force)
                   for s in songs]
        try:
            for fut in as_completed(futures):
                outcome, n = fut.result()
                tally[outcome] = tally.get(outcome, 0) + 1
                got_bytes += n
                done += 1
                if done % 25 == 0 or done == len(songs):
                    rate = got_bytes / max(1e-9, time.time() - started) / 1e6
                    print(f"  {done}/{len(songs)}  {got_bytes/1e9:.2f} GB  "
                          f"{rate:.1f} MB/s", flush=True)
        except KeyboardInterrupt:
            _stop = True
            print("\nstopping, finishing what is in flight", file=sys.stderr)

    # Second pass for records /download 500s on. They get marked during the
    # first pass and take the /stream path, which is not broken for them.
    retry = [s for s in songs if s["id"] in _broken and s["id"] not in by_id]
    if retry:
        print(f"\n  {len(retry)} record(s) the download endpoint errored on, "
              f"retrying via stream")
        for s in retry:
            outcome, n = fetch_one(s, out, by_id, args.timeout, False)
            tally[outcome] = tally.get(outcome, 0) + 1
            got_bytes += n

    save_index(by_id)
    print("\n" + "  ".join(f"{k} {v}" for k, v in sorted(tally.items())))
    print(f"on disk: {len(by_id)} tracks, "
          f"{sum(v.get('bytes',0) for v in by_id.values())/1e9:.2f} GB")
    if tally.get("limited"):
        print("the allowance ran out. Re-run later to pick up the rest.",
              file=sys.stderr)
    if tally.get("expired"):
        print("the token expired (they last 15 minutes). Copy a fresh one from "
              "devtools into .env and re-run: everything already saved is "
              "skipped, so it carries on where it stopped.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
