#!/usr/bin/env python3
"""Local dev server for 999.

    python serve.py

Plain `python -m http.server` works too, but it sends no cache headers, so
browsers hang on to JavaScript heuristically. A file edited mid-session then
stays stale in the browser and the resulting breakage looks like a real bug.
This sends no-store on everything instead.

Loopback only, on purpose. Nothing here is meant to be reachable from another
machine.
"""

import http.server
import os
import socketserver

# Resolved from this file rather than the working directory: the project
# folder is due to be renamed and a hardcoded path would rot.
os.chdir(os.path.dirname(os.path.abspath(__file__)))

HOST = "127.0.0.1"
PORT = 8777


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        super().end_headers()

    def guess_type(self, path):
        # http.server reads the JS type from the Windows registry, which on
        # some machines answers text/plain. Browsers hard-refuse ES modules
        # served that way and the page goes blank with no useful error.
        if path.endswith(".js"):
            return "application/javascript"
        if path.endswith(".json"):
            return "application/json"
        return super().guess_type(path)


socketserver.TCPServer.allow_reuse_address = True

with socketserver.TCPServer((HOST, PORT), Handler) as httpd:
    print(f"999 on http://{HOST}:{PORT}  (ctrl-c to stop)", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
