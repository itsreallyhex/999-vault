#!/usr/bin/env python3
"""Local dev server for 999.

    python serve.py

Plain `python -m http.server` works too, but it sends no cache headers, so
browsers hang on to JavaScript heuristically. A file edited mid-session then
stays stale in the browser and the resulting breakage looks like a real bug.
This sends no-store on everything instead.

It also does three things a plain http.server does not, all of which the audio
player needs:

  * It threads. socketserver.TCPServer handles one request at a time, and an
    <audio> element holds its connection open for as long as the track is
    streaming. On a single-threaded server that means one playing track blocks
    every cover, every module and the catalogue behind it, and the page looks
    frozen.
  * It answers Range requests with a 206. SimpleHTTPRequestHandler ignores the
    header and returns the whole file with a 200, so the browser cannot seek
    to anywhere it has not already buffered and a drag on the seek bar snaps
    back.
  * It pins the audio MIME types, for the same reason it already pins the one
    for .js: the types come from the Windows registry, which answers
    inconsistently, and a wrong one on an .m4a makes the element refuse a file
    that is perfectly good.

Loopback only, on purpose. Nothing here is meant to be reachable from another
machine.
"""

import http.server
import os
import re
import socketserver

# Resolved from this file rather than the working directory: the project
# folder is due to be renamed and a hardcoded path would rot.
os.chdir(os.path.dirname(os.path.abspath(__file__)))

HOST = "127.0.0.1"
PORT = 8777

RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")

# 64 KB at a time. Big enough that a 77 MB instrumental is not a million
# writes, small enough that an abandoned seek stops promptly.
CHUNK = 64 * 1024

AUDIO_TYPES = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler, plus byte ranges and honest MIME types."""

    #: Bytes still to be written for the current partial response, or None
    #: when this is an ordinary whole-file reply.
    _remaining = None

    def end_headers(self):
        # Saying so explicitly is what makes a browser willing to seek at
        # all: without it, it assumes one shot from byte zero.
        self.send_header("Accept-Ranges", "bytes")

        # The no-store rule exists so an edited module cannot stick in the
        # browser. Audio is never edited mid-session, and a track re-fetched
        # on every scrub is a lot of pointless disk, so it is the one
        # exception.
        if self._is_audio(self.path):
            self.send_header("Cache-Control", "private, max-age=3600")
        else:
            self.send_header(
                "Cache-Control", "no-store, no-cache, must-revalidate, max-age=0"
            )

        super().end_headers()

    @staticmethod
    def _is_audio(path):
        return os.path.splitext(path.split("?", 1)[0])[1].lower() in AUDIO_TYPES

    def guess_type(self, path):
        # http.server reads these from the Windows registry, which on some
        # machines answers text/plain. Browsers hard-refuse ES modules served
        # that way and the page goes blank with no useful error. The audio
        # types are pinned for the same reason.
        ext = os.path.splitext(path)[1].lower()
        if ext == ".js":
            return "application/javascript"
        if ext == ".json":
            return "application/json"
        if ext in AUDIO_TYPES:
            return AUDIO_TYPES[ext]
        return super().guess_type(path)

    def send_head(self):
        """Serve a 206 when a range was asked for, and defer otherwise."""
        self._remaining = None

        header = self.headers.get("Range")
        if not header:
            return super().send_head()

        match = RANGE_RE.match(header.strip())
        if not match:
            # Multi-range, and anything malformed: answer in full, which is
            # a legal response to a range request.
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()

        try:
            handle = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        try:
            stat = os.fstat(handle.fileno())
            size = stat.st_size
            first, last = match.group(1), match.group(2)

            if first == "":
                # "bytes=-500", meaning the last 500 bytes
                length = int(last or 0)
                start = max(0, size - length)
                end = size - 1
            else:
                start = int(first)
                end = int(last) if last else size - 1

            if start >= size or start > end:
                handle.close()
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return None

            end = min(end, size - 1)
            handle.seek(start)
            self._remaining = end - start + 1

            self.send_response(206)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Content-Length", str(self._remaining))
            self.send_header("Last-Modified", self.date_time_string(stat.st_mtime))
            self.end_headers()
            return handle
        except Exception:
            handle.close()
            raise

    def copyfile(self, source, outputfile):
        """Write the body, stopping at the end of the requested range.

        The inherited version copies to EOF, which would send the whole file
        after a 206 header promising only part of it.
        """
        try:
            if self._remaining is None:
                super().copyfile(source, outputfile)
                return

            remaining = self._remaining
            while remaining > 0:
                chunk = source.read(min(CHUNK, remaining))
                if not chunk:
                    break
                outputfile.write(chunk)
                remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # Normal for media: the element opens a range, decides it has
            # enough, and hangs up. Not worth a traceback in the log.
            pass

    def log_message(self, fmt, *args):
        # One line per range request would bury everything else, and a
        # playing track makes a great many of them.
        if self.command == "GET" and self._is_audio(self.path):
            return
        super().log_message(fmt, *args)


class Server(socketserver.ThreadingTCPServer):
    """Threaded, so a streaming track cannot block the rest of the page."""

    allow_reuse_address = True
    daemon_threads = True


with Server((HOST, PORT), Handler) as httpd:
    print(f"999 on http://{HOST}:{PORT}  (ctrl-c to stop)", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
