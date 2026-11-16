"""Mock Google Drive endpoint so the sync code can be proven before real credentials.

Implements just the three calls the Worker makes:
  POST /token              -> { access_token, expires_in }
  POST /upload/...         -> 200 + Location header (resumable session)
  PUT  /resume/<id>        -> 200 { id }
and records what it received so the test can assert names, sizes and types.

Run: python scripts/mock_drive.py [port]
"""
from __future__ import annotations

import json
import sys
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
LOG: list[dict] = []


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # keep the console readable
        pass

    def _json(self, code: int, payload: dict, extra: dict | None = None):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""

        if self.path.startswith("/token"):
            LOG.append({"at": datetime.now().isoformat(timespec="seconds"), "kind": "token"})
            return self._json(200, {"access_token": "mock-token", "expires_in": 3600})

        if self.path.startswith("/upload"):
            meta = {}
            try:
                meta = json.loads(body.decode() or "{}")
            except Exception:
                pass
            session = f"s{len(LOG)}"
            LOG.append({
                "at": datetime.now().isoformat(timespec="seconds"),
                "kind": "start",
                "name": meta.get("name"),
                "parents": meta.get("parents"),
                "ctype": self.headers.get("x-upload-content-type"),
                "size": self.headers.get("x-upload-content-length"),
                "auth": (self.headers.get("authorization") or "")[:20],
                "session": session,
            })
            return self._json(
                200,
                {},
                {"location": f"http://127.0.0.1:{PORT}/resume/{session}"},
            )

        if self.path == "/__log":  # test helper
            return self._json(200, {"entries": LOG})

        return self._json(404, {"error": "no such route"})

    def do_PUT(self):
        length = int(self.headers.get("content-length") or 0)
        received = 0
        while received < length:
            chunk = self.rfile.read(min(65536, length - received))
            if not chunk:
                break
            received += len(chunk)
        session = self.path.rsplit("/", 1)[-1]
        LOG.append({"at": datetime.now().isoformat(timespec="seconds"), "kind": "put", "session": session, "bytes": received})
        return self._json(200, {"id": f"drv-{session}", "size": str(received)})

    def do_GET(self):
        if self.path == "/__log":
            return self._json(200, {"entries": LOG})
        return self._json(404, {"error": "no such route"})


if __name__ == "__main__":
    print(f"mock drive on http://127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
