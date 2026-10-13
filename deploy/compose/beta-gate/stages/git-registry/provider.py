#!/usr/bin/env python3
"""GATE-005 authenticated HTTPS fixture for smart Git and npm registries."""

import argparse
import base64
import hashlib
import io
import json
import os
import shutil
import ssl
import subprocess
import tarfile
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def atomic_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True), encoding="utf-8")
    temporary.replace(path)


class State:
    def __init__(self, stats: Path):
        self.stats_path = stats
        self.lock = threading.Lock()
        self.value = {
            "authorization": 0,
            "gitAdvertise": 0,
            "gitReceive": 0,
            "gitUpload": 0,
            "metadata": 0,
            "missing": 0,
            "tarball": 0,
        }
        atomic_json(stats, self.value)

    def increment(self, field: str) -> None:
        with self.lock:
            self.value[field] += 1
            atomic_json(self.stats_path, self.value)

    def snapshot(self) -> bytes:
        with self.lock:
            return json.dumps(self.value, sort_keys=True).encode()


def make_tarball(package: str) -> bytes:
    body = f'module.exports = "{package}";\n'.encode()
    package_json = json.dumps({"name": package, "version": "1.0.0"}).encode()
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, payload in (("package/index.js", body), ("package/package.json", package_json)):
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            info.mode = 0o644
            info.mtime = 0
            archive.addfile(info, io.BytesIO(payload))
    return output.getvalue()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("git", "registry"), required=True)
    parser.add_argument("--port", type=int, default=8443)
    parser.add_argument("--cert", required=True)
    parser.add_argument("--key", required=True)
    token = parser.add_mutually_exclusive_group(required=True)
    token.add_argument("--token")
    token.add_argument("--token-file")
    parser.add_argument("--stats", required=True)
    parser.add_argument("--git-root")
    parser.add_argument("--registry-name", default="@gate/exact")
    parser.add_argument("--registry-label", default="exact")
    args = parser.parse_args()
    state = State(Path(args.stats))
    token_value = args.token if args.token is not None else Path(args.token_file).read_text(encoding="utf-8").strip()
    if not token_value or len(token_value) > 4096:
        raise ValueError("invalid provider token")
    expected_basic = "Basic " + base64.b64encode(f"git:{token_value}".encode()).decode()
    expected_bearer = f"Bearer {token_value}"
    tarball = make_tarball(args.registry_name)
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(tarball).digest()).decode()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            if self.path == "/__stats":
                return self.send(200, state.snapshot(), "application/json")
            if args.mode == "git":
                if self.path == "/capabilities":
                    return self.send(200, b'{"smartHttp":true}', "application/json")
                return self.git_backend()
            return self.registry_get()

        def do_POST(self):
            if args.mode == "git" and self.path == "/__commit":
                size = int(self.headers.get("Content-Length", "0"))
                value = self.rfile.read(size).decode("utf-8")
                work = Path(args.git_root).parent / "gate-control-work"
                if work.exists():
                    shutil.rmtree(work)
                subprocess.run(["git", "clone", "--branch", "main", str(Path(args.git_root) / "repo.git"), str(work)], check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                (work / "README.md").write_text(value + "\n", encoding="utf-8")
                subprocess.run(["git", "-C", str(work), "add", "README.md"], check=True)
                subprocess.run(["git", "-C", str(work), "-c", "user.name=GATE-005",
                                "-c", "user.email=gate@example.invalid", "commit", "-m", "fixture advance"], check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                subprocess.run(["git", "-C", str(work), "push", "origin", "HEAD:main"], check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return self.send(204, b"", "application/octet-stream")
            if args.mode == "git":
                return self.git_backend()
            return self.send(404, b'{"error":"not_found"}', "application/json")

        def authorized(self, expected: str) -> bool:
            if self.headers.get("Authorization") != expected:
                self.send_response(401)
                self.send_header("WWW-Authenticate", 'Basic realm="gate"')
                self.send_header("Content-Length", "0")
                self.end_headers()
                return False
            state.increment("authorization")
            return True

        def registry_get(self):
            if not self.authorized(expected_bearer):
                return
            parsed = urllib.parse.urlsplit(self.path)
            if parsed.path.endswith("/-/ping"):
                return self.send(200, b"{}", "application/json")
            encoded = urllib.parse.quote(args.registry_name, safe="@")
            if parsed.path.endswith(f"/{encoded}") or parsed.path.endswith(f"/{args.registry_name}"):
                state.increment("metadata")
                origin = f"https://{self.headers['Host']}"
                body = json.dumps({
                    "name": args.registry_name,
                    "dist-tags": {"latest": "1.0.0"},
                    "versions": {"1.0.0": {"name": args.registry_name, "version": "1.0.0", "dist": {
                        "integrity": integrity,
                        "tarball": f"{origin}/tarballs/{args.registry_label}-1.0.0.tgz",
                    }}},
                }).encode()
                return self.send(200, body, "application/json")
            if parsed.path == f"/tarballs/{args.registry_label}-1.0.0.tgz":
                state.increment("tarball")
                return self.send(200, tarball, "application/octet-stream")
            state.increment("missing")
            return self.send(404, b'{"error":"missing"}', "application/json")

        def git_backend(self):
            if not self.authorized(expected_basic):
                return
            parsed = urllib.parse.urlsplit(self.path)
            body = self.read_body()
            environment = os.environ.copy()
            environment.update({
                "GIT_PROJECT_ROOT": args.git_root,
                "GIT_HTTP_EXPORT_ALL": "1",
                "PATH_INFO": parsed.path,
                "QUERY_STRING": parsed.query,
                "REQUEST_METHOD": self.command,
                "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                "CONTENT_LENGTH": str(len(body)),
                "REMOTE_USER": "git",
            })
            process = subprocess.run(["git", "http-backend"], input=body, env=environment,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
            if process.returncode != 0 or b"\r\n\r\n" not in process.stdout:
                return self.send(500, b"", "application/octet-stream")
            if "git-receive-pack" in self.path:
                state.increment("gitReceive")
            elif "git-upload-pack" in self.path:
                state.increment("gitUpload")
            else:
                state.increment("gitAdvertise")
            header_block, payload = process.stdout.split(b"\r\n\r\n", 1)
            status = 200
            headers = []
            for line in header_block.decode("latin-1").split("\r\n"):
                name, value = line.split(":", 1)
                if name.lower() == "status":
                    status = int(value.strip().split(" ", 1)[0])
                else:
                    headers.append((name, value.strip()))
            self.send_response(status)
            for name, value in headers:
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def read_body(self) -> bytes:
            if self.headers.get("Transfer-Encoding", "").lower() != "chunked":
                return self.rfile.read(int(self.headers.get("Content-Length", "0")))
            chunks = []
            while True:
                size = int(self.rfile.readline().split(b";", 1)[0].strip(), 16)
                if size == 0:
                    self.rfile.readline()
                    return b"".join(chunks)
                chunks.append(self.rfile.read(size))
                self.rfile.read(2)

        def send(self, status: int, body: bytes, content_type: str):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(args.cert, args.key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
