import http.server
import json
import os
import ssl
import subprocess
import time
import urllib.parse
import base64
import hashlib


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

    def do_POST(self):
        with open(os.path.join(CONTROL, "requests"), "a", encoding="utf-8") as value:
            value.write(self.path + "\n")
        if self.path != "/token":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 16384:
            self.send_response(400)
            self.end_headers()
            return
        form = urllib.parse.parse_qs(self.rfile.read(length).decode(), strict_parsing=True)
        required = ["grant_type", "code", "redirect_uri", "client_id", "client_secret", "code_verifier"]
        if any(len(form.get(key, [])) != 1 for key in required) or form["grant_type"][0] != "authorization_code":
            self.send_response(400)
            self.end_headers()
            return
        code = form["code"][0]
        def control_path(name):
            scoped = os.path.join(CONTROL, name + "-" + code)
            return scoped if os.path.exists(scoped) else os.path.join(CONTROL, name)
        with open(control_path("pkce_challenge"), encoding="utf-8") as value:
            expected_challenge = value.read().strip()
        observed_challenge = base64.urlsafe_b64encode(
            hashlib.sha256(form["code_verifier"][0].encode()).digest()
        ).rstrip(b"=").decode()
        if (form["redirect_uri"][0] != ISSUER + "/callback"
                or form["client_id"][0] != "protocol-client"
                or form["client_secret"][0] != "protocol-secret"
                or observed_challenge != expected_challenge):
            self.send_response(400)
            self.end_headers()
            return
        with open(control_path("token_mode"), encoding="utf-8") as value:
            mode = value.read().strip()
        with open(control_path("nonce"), encoding="utf-8") as value:
            nonce = value.read().strip()
        now = int(time.time())
        header = {"alg": "none" if mode == "wrong-alg" else "RS256", "kid": "missing" if mode == "wrong-kid" else "fixture"}
        subject_path = control_path("subject")
        email_path = control_path("email")
        subject = "fixture-subject"
        if os.path.exists(subject_path):
            with open(subject_path, encoding="utf-8") as value:
                subject = value.read().strip()
        claims = {
            "iss": "https://wrong-issuer.example.test" if mode == "wrong-issuer" else ISSUER,
            "sub": subject,
            "aud": "wrong-client" if mode == "wrong-aud" else "protocol-client",
            "nonce": nonce,
            "iat": now,
            "exp": now + 300,
        }
        if os.path.exists(email_path):
            with open(email_path, encoding="utf-8") as value:
                email = value.read().strip()
            if email:
                claims["email"] = email
                claims["email_verified"] = mode != "unverified-email"
        if mode == "wrong-azp":
            claims["aud"] = ["protocol-client", "other-client"]
            claims["azp"] = "other-client"
        if mode == "future":
            claims["iat"] = now + 300
            claims["exp"] = now + 600
        if mode == "expired":
            claims["iat"] = now - 700
            claims["exp"] = now - 400
        def encode(value):
            return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).rstrip(b"=").decode()
        signing_input = (encode(header) + "." + encode(claims)).encode()
        signature = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", os.path.join(CONTROL, "jwt.key")],
            input=signing_input,
            check=True,
            capture_output=True,
        ).stdout
        if mode == "bad-signature":
            signature = bytes([signature[0] ^ 1]) + signature[1:]
        token = signing_input.decode() + "." + base64.urlsafe_b64encode(signature).rstrip(b"=").decode()
        encoded = json.dumps({"id_token": token}, separators=(",", ":")).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
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
