#!/usr/bin/env python3
import base64
import os
import ssl
import subprocess
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT, WORK, CERT, KEY, TOKEN, ORIGIN_PORT, SINK_PORT = sys.argv[1:]
EXPECTED_AUTH = "Basic " + base64.b64encode(("git:" + TOKEN).encode()).decode()
redirect_authorization_count = 0
count_lock = threading.Lock()


def run_git(*args, cwd=None):
    subprocess.run(["git", *args], cwd=cwd, check=True, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL)


def make_fixture_commit(content):
    run_git("fetch", "origin", cwd=WORK)
    run_git("reset", "--hard", "origin/main", cwd=WORK)
    with open(os.path.join(WORK, "README.md"), "w", encoding="utf-8") as handle:
        handle.write(content + "\n")
    run_git("add", "README.md", cwd=WORK)
    run_git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
            "commit", "-m", "fixture update", cwd=WORK)
    run_git("push", "origin", "HEAD:main", cwd=WORK)


class OriginHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        if self.path == "/__commit":
            size = int(self.headers.get("Content-Length", "0"))
            content = self.rfile.read(size).decode("utf-8")
            make_fixture_commit(content)
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.git_backend()

    def do_GET(self):
        if self.path == "/__redirect-auth-count":
            with count_lock:
                payload = str(redirect_authorization_count).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if self.path.startswith("/redirect.git"):
            location = f"https://localhost:{SINK_PORT}/captured"
            self.send_response(302)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.git_backend()

    def git_backend(self):
        print(f"{self.command} {self.path} auth={bool(self.headers.get('Authorization'))} transfer={self.headers.get('Transfer-Encoding')}", flush=True)
        if self.headers.get("Authorization") != EXPECTED_AUTH:
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="fixture"')
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        parsed = urllib.parse.urlsplit(self.path)
        length = int(self.headers.get("Content-Length", "0"))
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            chunks = []
            while True:
                size = int(self.rfile.readline().split(b";", 1)[0].strip(), 16)
                if size == 0:
                    self.rfile.readline()
                    break
                chunks.append(self.rfile.read(size))
                self.rfile.read(2)
            body = b"".join(chunks)
            length = len(body)
        else:
            body = self.rfile.read(length) if length else b""
        env = os.environ.copy()
        env.update({
            "GIT_PROJECT_ROOT": ROOT,
            "GIT_HTTP_EXPORT_ALL": "1",
            "PATH_INFO": parsed.path,
            "QUERY_STRING": parsed.query,
            "REQUEST_METHOD": self.command,
            "CONTENT_TYPE": self.headers.get("Content-Type", ""),
            "CONTENT_LENGTH": str(length),
            "REMOTE_USER": "git",
        })
        process = subprocess.run(["git", "http-backend"], input=body, env=env,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if process.returncode != 0:
            print(process.stderr.decode("utf-8", errors="replace"), flush=True)
            self.send_error(500)
            return
        header_block, payload = process.stdout.split(b"\r\n\r\n", 1)
        headers = header_block.decode("latin-1").split("\r\n")
        status = 200
        forwarded = []
        for line in headers:
            name, value = line.split(":", 1)
            if name.lower() == "status":
                status = int(value.strip().split(" ", 1)[0])
            else:
                forwarded.append((name, value.strip()))
        self.send_response(status)
        for name, value in forwarded:
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_):
        pass


class SinkHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        global redirect_authorization_count
        if self.headers.get("Authorization"):
            with count_lock:
                redirect_authorization_count += 1
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_POST = do_GET

    def log_message(self, *_):
        pass


def server(port, handler):
    instance = ThreadingHTTPServer(("127.0.0.1", int(port)), handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(CERT, KEY)
    instance.socket = context.wrap_socket(instance.socket, server_side=True)
    return instance


origin = server(ORIGIN_PORT, OriginHandler)
sink = server(SINK_PORT, SinkHandler)
threading.Thread(target=sink.serve_forever, daemon=True).start()
origin.serve_forever()
