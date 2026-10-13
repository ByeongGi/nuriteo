import base64
import hashlib
import http.server
import json
import os
import secrets
import ssl
import subprocess
import threading
import time
import urllib.parse

CONTROL = os.environ["OIDC_CONTROL_DIR"]
ISSUER = os.environ["OIDC_ISSUER"]
FORWARD_ORIGIN = os.environ["OIDC_CALLBACK_FORWARD_ORIGIN"].rstrip("/")
LOCK = threading.Lock()
CODES = {}


def read(name):
    with open(os.path.join(CONTROL, name), encoding="utf-8") as value:
        return value.read().strip()


def update_stats(change):
    path = os.path.join(CONTROL, "oidc-stats.json")
    with LOCK:
        with open(path, encoding="utf-8") as value:
            stats = json.load(value)
        change(stats)
        temporary = path + ".tmp"
        with open(temporary, "w", encoding="utf-8") as value:
            json.dump(stats, value, separators=(",", ":"), sort_keys=True)
        os.replace(temporary, path)


def b64(value):
    if not isinstance(value, bytes):
        value = json.dumps(value, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


class Handler(http.server.BaseHTTPRequestHandler):
    def json(self, status, body):
        encoded = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            return self.json(200, {"status": "ready", "provider": "oidc"})
        if parsed.path == "/.well-known/openid-configuration":
            return self.json(200, {
                "issuer": ISSUER,
                "authorization_endpoint": ISSUER + "/authorize",
                "token_endpoint": ISSUER + "/token",
                "jwks_uri": ISSUER + "/jwks",
                "response_types_supported": ["code"],
                "subject_types_supported": ["public"],
                "id_token_signing_alg_values_supported": ["RS256"],
                "code_challenge_methods_supported": ["S256"],
            })
        if parsed.path == "/jwks":
            with open(os.path.join(CONTROL, "jwks.json"), encoding="utf-8") as value:
                return self.json(200, json.load(value))
        if parsed.path == "/authorize":
            query = urllib.parse.parse_qs(parsed.query, strict_parsing=True)
            required = ["client_id", "redirect_uri", "response_type", "scope", "state", "nonce", "code_challenge", "code_challenge_method"]
            if any(len(query.get(key, [])) != 1 for key in required):
                return self.json(400, {"error": "invalid_request"})
            if query["client_id"][0] != "gate-005" or query["response_type"][0] != "code" or query["code_challenge_method"][0] != "S256" or "openid" not in query["scope"][0].split():
                return self.json(400, {"error": "invalid_request"})
            redirect = urllib.parse.urlparse(query["redirect_uri"][0])
            if redirect.scheme != "https" or redirect.hostname != "oidc-provider" or not redirect.path.startswith("/callback-proxy/"):
                return self.json(400, {"error": "invalid_redirect_uri"})
            code = secrets.token_urlsafe(32)
            with LOCK:
                CODES[code] = {
                    "challenge": query["code_challenge"][0], "nonce": query["nonce"][0],
                    "redirect_uri": query["redirect_uri"][0], "created": time.time(),
                }
            update_stats(lambda stats: (stats.__setitem__("authorize", stats["authorize"] + 1), stats.__setitem__("stateRoundTrips", stats["stateRoundTrips"] + 1)))
            separator = "&" if urllib.parse.urlparse(query["redirect_uri"][0]).query else "?"
            location = query["redirect_uri"][0] + separator + urllib.parse.urlencode({"iss": ISSUER, "state": query["state"][0], "code": code})
            self.send_response(302)
            self.send_header("Location", location)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        if parsed.path.startswith("/callback-proxy/"):
            provider_id = parsed.path.removeprefix("/callback-proxy/")
            if not provider_id or "/" in provider_id:
                return self.json(400, {"error": "invalid_callback"})
            self.send_response(302)
            self.send_header("Location", f"{FORWARD_ORIGIN}/api/v1/auth/oidc/{provider_id}/callback?{parsed.query}")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        self.json(404, {"error": "not_found"})

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != "/token":
            return self.json(404, {"error": "not_found"})
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 16384:
            return self.json(400, {"error": "invalid_request"})
        form = urllib.parse.parse_qs(self.rfile.read(length).decode(), strict_parsing=True)
        required = ["grant_type", "code", "redirect_uri", "client_id", "client_secret", "code_verifier"]
        if any(len(form.get(key, [])) != 1 for key in required):
            return self.json(400, {"error": "invalid_request"})
        with LOCK:
            record = CODES.pop(form["code"][0], None)
        challenge = b64(hashlib.sha256(form["code_verifier"][0].encode()).digest())
        if record is None or time.time() - record["created"] > 300 or form["grant_type"][0] != "authorization_code" or form["client_id"][0] != "gate-005" or form["client_secret"][0] != "gate-005-client-secret" or form["redirect_uri"][0] != record["redirect_uri"] or challenge != record["challenge"]:
            return self.json(400, {"error": "invalid_grant"})
        kid = read("active-kid")
        key = "jwt.key" if kid == "gate-current" else "jwt-next.key"
        now = int(time.time())
        header = {"alg": "RS256", "kid": kid, "typ": "JWT"}
        claims = {"iss": ISSUER, "sub": read("oidc-subject"), "aud": "gate-005", "nonce": record["nonce"], "iat": now, "exp": now + 300, "email": read("oidc-email"), "email_verified": True}
        signing_input = (b64(header) + "." + b64(claims)).encode()
        signature = subprocess.run(["openssl", "dgst", "-sha256", "-sign", os.path.join(CONTROL, key)], input=signing_input, check=True, capture_output=True).stdout
        token = signing_input.decode() + "." + b64(signature)
        def changed(stats):
            stats["token"] += 1
            stats["pkceVerified"] += 1
            stats["nonceSigned"] += 1
            if kid not in stats["kids"]:
                stats["kids"].append(kid)
        update_stats(changed)
        self.json(200, {"id_token": token, "token_type": "Bearer", "expires_in": 300})

    def log_message(self, _format, *_args):
        pass


server = http.server.ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("OIDC_PORT", "8443"))), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(os.environ["OIDC_CERT"], os.environ["OIDC_KEY"])
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
