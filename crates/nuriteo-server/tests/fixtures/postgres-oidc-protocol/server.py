import http.server
import json
import os
import ssl
import time


CONTROL = os.environ["OIDC_CONTROL_DIR"]
ISSUER = os.environ["OIDC_ISSUER"]


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        with open(os.path.join(CONTROL, "requests"), "a", encoding="utf-8") as value:
            value.write(self.path + "\n")
        delay_path = os.path.join(CONTROL, "delay")
        if os.path.exists(delay_path):
            with open(delay_path, encoding="utf-8") as value:
                time.sleep(float(value.read().strip() or "0"))
        if self.path == "/.well-known/openid-configuration":
            with open(os.path.join(CONTROL, "mode"), encoding="utf-8") as value:
                mode = value.read().strip()
            if mode == "redirect":
                self.send_response(302)
                self.send_header("Location", ISSUER + "/redirect-target")
                self.end_headers()
                return
            if mode == "oversize":
                encoded = b"{" + b" " * (65 * 1024) + b"}"
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
                return
            body = {
                "issuer": "https://mismatch.example.test" if mode == "mismatch" else ISSUER,
                "authorization_endpoint": ISSUER + "/authorize",
                "token_endpoint": ISSUER + "/token",
                "jwks_uri": ISSUER + "/jwks",
            }
            if mode == "cross-host":
                body["jwks_uri"] = body["jwks_uri"].replace("localhost", "127.0.0.1")
        elif self.path == "/jwks":
            with open(os.path.join(CONTROL, "mode"), encoding="utf-8") as value:
                mode = value.read().strip()
            if mode == "too-many-keys":
                body = {"keys": [{"kty": "RSA", "kid": f"key-{index}"} for index in range(129)]}
            else:
                with open(os.path.join(CONTROL, "jwks.json"), encoding="utf-8") as value:
                    body = json.load(value)
        else:
            self.send_response(404)
            self.end_headers()
            return
        encoded = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "max-age=60")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, _format, *_args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", int(os.environ["OIDC_PORT"])), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(os.environ["OIDC_CERT"], os.environ["OIDC_KEY"])
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
