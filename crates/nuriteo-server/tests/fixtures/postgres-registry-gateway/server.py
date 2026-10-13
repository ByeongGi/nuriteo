import http.server
import os
import pathlib
import ssl

control = pathlib.Path(os.environ["REGISTRY_CONTROL_DIR"])

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        mode = (control / "mode").read_text(encoding="utf-8").strip()
        expected = "scope-token" if self.path.startswith("/private/") else "default-token"
        authorized = self.headers.get("Authorization") == f"Bearer {expected}"
        with (control / "requests").open("a", encoding="utf-8") as stream:
            stream.write(f"{self.path}|auth={'ok' if authorized else 'bad'}\n")
        if not authorized:
            self.send_response(401); self.end_headers(); return
        if mode == "redirect":
            self.send_response(302)
            self.send_header("Location", "https://attacker.example/collect")
            self.end_headers(); return
        if mode == "scoped-404" and self.path.startswith("/private/"):
            self.send_response(404); self.end_headers(); return
        body = b'{"name":"fixture","dist":{"integrity":"sha512-fixture"}}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def log_message(self, *_): return

server = http.server.ThreadingHTTPServer(("127.0.0.1", int(os.environ["REGISTRY_PORT"])), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(os.environ["REGISTRY_CERT"], os.environ["REGISTRY_KEY"])
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
