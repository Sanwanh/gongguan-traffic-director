#!/usr/bin/env python3
"""Cache-aware static server for the robot package (SPEC_VIEWER_V2 1b).

Replaces the bare ``python3 -m http.server`` on port 8124 with the same
``--directory`` semantics, plus:

* ``Cache-Control: no-cache`` for .html/.js/.mjs/.css/.json responses;
* ``Cache-Control: no-cache`` for .glb, upgraded to
  ``public, max-age=31536000, immutable`` when requested with a ``?v=``
  cache-busting stamp (written by mujoco/stamp_versions.py);
* ``.mjs`` served as ``text/javascript``.

Usage: python3 serve.py [--port 8124] [--directory <package root>]
"""
from __future__ import annotations

import argparse
import functools
import http.server
import posixpath
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

MIME_OVERRIDES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".glb": "model/gltf-binary",
    ".wasm": "application/wasm",
}
NO_CACHE_SUFFIXES = (".html", ".js", ".mjs", ".css", ".json")


class CacheControlHandler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        extension = posixpath.splitext(str(path))[1].lower()
        if extension in MIME_OVERRIDES:
            return MIME_OVERRIDES[extension]
        return super().guess_type(path)

    def end_headers(self):
        split = urlsplit(self.path)
        request_path = split.path.lower()
        if request_path.endswith(NO_CACHE_SUFFIXES):
            self.send_header("Cache-Control", "no-cache")
        elif request_path.endswith(".glb"):
            if parse_qs(split.query).get("v"):
                self.send_header(
                    "Cache-Control", "public, max-age=31536000, immutable",
                )
            else:
                self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Cache-aware static server for the robot package",
    )
    parser.add_argument("--port", type=int, default=8124)
    parser.add_argument(
        "--directory",
        default=str(Path(__file__).resolve().parent),
        help="directory to serve (default: this package root)",
    )
    args = parser.parse_args()
    handler = functools.partial(CacheControlHandler, directory=args.directory)
    with http.server.ThreadingHTTPServer(("", args.port), handler) as server:
        print(f"serving {args.directory} on port {args.port}")
        server.serve_forever()


if __name__ == "__main__":
    main()
