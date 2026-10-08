import http.server
import os
import pathlib
import ssl


control = pathlib.Path(os.environ["GIT_CONTROL_DIR"])


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        with (control / "requests").open("a", encoding="utf-8") as stream:
            stream.write(self.path + "\n")
        mode = (control / "mode").read_text(encoding="utf-8").strip()
        if mode == "redirect":
            self.send_response(302)
            self.send_header("Location", "https://attacker.example/collect")
            self.end_headers()
            return
        if mode == "oversize":
            body = b"x" * (64 * 1024 + 1)
        else:
            body = b'{"service":"git-fixture"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        return


server = http.server.ThreadingHTTPServer(("127.0.0.1", int(os.environ["GIT_PORT"])), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(os.environ["GIT_CERT"], os.environ["GIT_KEY"])
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
