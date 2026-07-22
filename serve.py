#!/usr/bin/env python3
"""Dev-only static server.

Serves the exact same files as `python -m http.server`, but adds no-cache headers
so edited JS/CSS/CSV are always re-fetched. This avoids the stale ES-module
caching that makes the page hang at "loading..." after a source edit (one cached
module breaks the import chain).

Production (GitHub Pages) is unaffected and sends its own cache headers — this
script is purely a local-dev convenience. Files served are byte-for-byte the same.

    python serve.py [port]      # default: $PORT env, else 8000

Then open http://localhost:8000/ . Use a normal refresh; no hard-refresh needed.
"""
import os
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        # Cross-origin isolation → SharedArrayBuffer → onnxruntime-web wasm threads (Scanner OCR).
        # GitHub Pages can't send these; production uses a coi-serviceworker to the same effect.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()


def main():
    # ThreadingHTTPServer (same as `python -m http.server`) so the browser's
    # persistent keep-alive connections don't serialize/block parallel requests.
    # CLI arg wins; otherwise honor $PORT (lets the preview harness assign a free
    # port without colliding with a manually-launched `serve.py 8000`), else 8000.
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 8000))
    httpd = ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler)
    print(f"Serving http://127.0.0.1:{port}/ (no-cache dev mode) - Ctrl+C to stop")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.server_close()


if __name__ == "__main__":
    main()
