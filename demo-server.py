import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent
ALLOWED_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/app.js": "app.js",
    "/financial.js": "financial.js",
    "/styles.css": "styles.css",
    "/config.js": "config.js",
    "/demo-data.js": "demo-data.js",
}


class DemoHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        remote_address = self.client_address[0].replace("::ffff:", "")
        if remote_address not in {"127.0.0.1", "::1"}:
            self.send_error(403, "Local preview is available only on this machine")
            return
        if urlsplit(self.path).path == "/api/auth/session":
            body = json.dumps({
                "authenticated": False,
                "csrfToken": None,
                "demoMode": True,
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def translate_path(self, request_path):
        relative = ALLOWED_FILES.get(urlsplit(request_path).path)
        if relative is None:
            return str(ROOT / "__not_served__")
        return str(ROOT / relative)

    def list_directory(self, _path):
        self.send_error(404, "Not found")
        return None


if __name__ == "__main__":
    address = ("127.0.0.1", 8000)
    print(f"Local illustrative dashboard: http://{address[0]}:{address[1]}")
    print("Serving the local preview allowlist; no database or live operational feed is used.")
    ThreadingHTTPServer(address, DemoHandler).serve_forever()
