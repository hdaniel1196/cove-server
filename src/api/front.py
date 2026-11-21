"""Cove Server's front door. Does what a web server like nginx would do, in plain Python, so one program runs
the same in Docker, as a Windows service and as a Mac app:

- serves the Cove app (web/), the Books app (books/ at /books/) and the first-run setup page (setup/ at /setup/)
- passes /jf/ through to Jellyfin and /api/ to Kavita, streaming (video ranges, no buffering), including Jellyfin's
  live websocket (/jf/socket)
- keeps Jellyfin's password sign-in closed (/jf/Users/AuthenticateByName): people sign in through Cove

Used only when COVE_FRONT=1 (an install with its own web server in front can leave it off).
"""
import http.client
import mimetypes
import os
import select
import socket
import ssl
import urllib.parse

HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "transfer-encoding",
       "upgrade", "host", "content-length"}
TYPES = {".js": "application/javascript", ".mjs": "application/javascript", ".css": "text/css", ".html": "text/html; charset=utf-8",
         ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png",
         ".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
         ".map": "application/json", ".wasm": "application/wasm"}
CHUNK = 256 * 1024


class Front:
    def __init__(self, web, books, setup, config, setup_done):
        self.web, self.books, self.setup = web, books, setup
        self.config = config            # function -> current settings dict
        self.setup_done = setup_done    # function -> bool

    # ------------------------------------------------------------------ routing
    def handle(self, h):
        path = urllib.parse.urlsplit(h.path).path
        if path.startswith("/cove-api/"):
            return False                               # cove-api's own routes
        if not self.setup_done():
            if path.startswith("/setup/"):
                return self.static(h, self.setup, path[len("/setup/"):], spa=False)
            return self.redirect(h, "/setup/")
        if path.startswith("/setup"):
            return self.redirect(h, "/")
        if path == "/jf/Users/AuthenticateByName":
            return self.plain(h, 403, "Sign in through Cove")
        if path.startswith("/jf/"):
            v = self.config().get("video") or {}
            return self.proxy(h, v.get("url"), h.path[len("/jf"):])
        if path.startswith("/api/"):
            b = self.config().get("books") or {}
            return self.proxy(h, b.get("url"), h.path)
        if path == "/books":
            return self.redirect(h, "/books/")
        if path.startswith("/books/"):
            return self.static(h, self.books, path[len("/books/"):], spa=True)
        return self.static(h, self.web, path.lstrip("/"), spa=True)

    # ------------------------------------------------------------------ small answers
    def plain(self, h, code, text):
        b = text.encode()
        h.send_response(code)
        h.send_header("Content-Type", "text/plain; charset=utf-8")
        h.send_header("Content-Length", str(len(b)))
        h.end_headers()
        if h.command != "HEAD":
            h.wfile.write(b)
        return True

    def redirect(self, h, to):
        h.send_response(302)
        h.send_header("Location", to)
        h.send_header("Content-Length", "0")
        h.end_headers()
        return True

    # ------------------------------------------------------------------ files
    def static(self, h, root, rel, spa):
        if h.command not in ("GET", "HEAD"):
            return self.plain(h, 405, "Not allowed")
        rel = urllib.parse.unquote(rel)
        full = os.path.realpath(os.path.join(root, rel))
        base = os.path.realpath(root)
        if not (full == base or full.startswith(base + os.sep)):
            return self.plain(h, 404, "Not found")
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            if spa and "." not in os.path.basename(rel):
                full = os.path.join(base, "index.html")   # the app's own pages (#/... and deep links)
            else:
                return self.plain(h, 404, "Not found")
        ext = os.path.splitext(full)[1].lower()
        ctype = TYPES.get(ext) or mimetypes.guess_type(full)[0] or "application/octet-stream"
        size = os.path.getsize(full)
        h.send_response(200)
        h.send_header("Content-Type", ctype)
        h.send_header("Content-Length", str(size))
        h.send_header("Cache-Control", "no-cache")
        h.send_header("X-Content-Type-Options", "nosniff")
        h.end_headers()
        if h.command == "GET":
            with open(full, "rb") as f:
                while True:
                    b = f.read(CHUNK)
                    if not b:
                        break
                    h.wfile.write(b)
        return True

    # ------------------------------------------------------------------ pass-through
    def proxy(self, h, base, rest):
        if not base:
            return self.plain(h, 503, "Not connected")
        u = urllib.parse.urlsplit(base)
        target = (u.path.rstrip("/") + rest) or "/"
        port = u.port or (443 if u.scheme == "https" else 80)
        if (h.headers.get("Upgrade") or "").lower() == "websocket":
            return self.tunnel(h, u, port, target)
        headers = {k: v for k, v in h.headers.items() if k.lower() not in HOP}
        headers["Host"] = u.netloc
        ip = h.client_address[0]
        headers["X-Forwarded-For"] = (h.headers.get("X-Forwarded-For") + ", " + ip) if h.headers.get("X-Forwarded-For") else ip
        headers["X-Real-IP"] = ip
        headers["X-Forwarded-Proto"] = h.headers.get("X-Forwarded-Proto") or "http"
        length = int(h.headers.get("Content-Length") or 0)
        conn = (http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection)(u.hostname, port, timeout=600)
        try:
            conn.putrequest(h.command, target, skip_host=True, skip_accept_encoding=True)
            for k, v in headers.items():
                conn.putheader(k, v)
            if length:
                conn.putheader("Content-Length", str(length))
            conn.endheaders()
            left = length
            while left > 0:                            # request body streams through too (uploads)
                b = h.rfile.read(min(CHUNK, left))
                if not b:
                    break
                conn.send(b)
                left -= len(b)
            r = conn.getresponse()
        except (OSError, http.client.HTTPException):
            conn.close()
            return self.plain(h, 502, "Can't reach the server behind Cove")
        try:
            h.send_response(r.status, r.reason)
            clen = r.getheader("Content-Length")
            for k, v in r.getheaders():
                if k.lower() not in HOP:
                    h.send_header(k, v)
            if clen is not None:
                h.send_header("Content-Length", clen)
            else:
                h.close_connection = True              # length unknown: the end of the stream is the end of the body
            h.end_headers()
            if h.command != "HEAD" and r.status not in (204, 304):
                while True:
                    b = r.read1(CHUNK) if hasattr(r, "read1") else r.read(CHUNK)
                    if not b:
                        break
                    h.wfile.write(b)
        except (OSError, http.client.HTTPException):
            h.close_connection = True                  # viewer closed the player or skipped ahead: normal
        finally:
            conn.close()
        return True

    def tunnel(self, h, u, port, target):
        """Websocket (Jellyfin's live link): send the handshake on, then pipe bytes both ways until either side closes."""
        try:
            up = socket.create_connection((u.hostname, port), timeout=15)
            if u.scheme == "https":
                up = ssl.create_default_context().wrap_socket(up, server_hostname=u.hostname)
        except OSError:
            return self.plain(h, 502, "Can't reach the server behind Cove")
        lines = [f"{h.command} {target} HTTP/1.1", f"Host: {u.netloc}"]
        lines += [f"{k}: {v}" for k, v in h.headers.items() if k.lower() != "host"]
        up.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
        down = h.connection
        up.settimeout(None)
        down.settimeout(None)
        try:
            while True:
                r, _, _ = select.select([up, down], [], [], 300)
                if not r:
                    break
                for s in r:
                    b = s.recv(CHUNK)
                    if not b:
                        raise ConnectionError
                    (down if s is up else up).sendall(b)
        except OSError:
            pass
        finally:
            up.close()
            h.close_connection = True
        return True
