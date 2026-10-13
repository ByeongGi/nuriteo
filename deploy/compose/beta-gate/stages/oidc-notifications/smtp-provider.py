import base64
import json
import os
import re
import socket
import ssl
import threading

CONTROL = os.environ["SMTP_CONTROL_DIR"]
LOCK = threading.Lock()


def read(name):
    with open(os.path.join(CONTROL, name), encoding="utf-8") as value:
        return value.read().strip()


def update(change):
    path = os.path.join(CONTROL, "smtp-stats.json")
    with LOCK:
        with open(path, encoding="utf-8") as value:
            stats = json.load(value)
        change(stats)
        temporary = path + ".tmp"
        with open(temporary, "w", encoding="utf-8") as value:
            json.dump(stats, value, separators=(",", ":"), sort_keys=True)
        os.replace(temporary, path)


def line(connection):
    data = b""
    while not data.endswith(b"\r\n"):
        chunk = connection.recv(1)
        if not chunk or len(data) > 16384:
            raise RuntimeError("invalid SMTP command")
        data += chunk
    return data


def message(connection):
    data = b""
    while not data.endswith(b"\r\n.\r\n"):
        chunk = connection.recv(4096)
        if not chunk or len(data) > 262144:
            raise RuntimeError("invalid SMTP message")
        data += chunk
    return data


def capture_invitation(payload):
    wire = payload[: -len(b"\r\n.\r\n")]
    try:
        _, encoded_body = wire.split(b"\r\n\r\n", 1)
        body = base64.b64decode(encoded_body.replace(b"\r\n", b""), validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return
    for name, pattern in (
        ("smtp-activation-url", r"https?://\S+/activate\?token=nrt_inv_[A-Za-z0-9_-]{43}"),
        (
            "smtp-organization-url",
            r"https?://\S+/organization-invitations/accept\?token=nrt_org_inv_[A-Za-z0-9_-]{43}",
        ),
    ):
        match = re.search(pattern, body)
        if match is None:
            continue
        path = os.path.join(CONTROL, name)
        temporary = path + ".tmp"
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as value:
            value.write(match.group(0))
        os.replace(temporary, path)


def handle(raw):
    update(lambda stats: stats.__setitem__("connections", stats["connections"] + 1))
    try:
        with TLS.wrap_socket(raw, server_side=True) as connection:
            connection.sendall(b"220 gate-005 ESMTP ready\r\n")
            if not line(connection).startswith(b"EHLO "):
                return
            connection.sendall(b"250-gate-005\r\n250 AUTH PLAIN\r\n")
            auth = line(connection)
            expected = ("\0" + read("smtp-username") + "\0" + read("smtp-password")).encode()
            try:
                supplied = base64.b64decode(auth.removeprefix(b"AUTH PLAIN ").strip(), validate=True)
            except Exception:
                supplied = b""
            if not auth.startswith(b"AUTH PLAIN ") or supplied != expected:
                update(lambda stats: stats.__setitem__("authFailures", stats["authFailures"] + 1))
                connection.sendall(b"535 authentication rejected\r\n")
                return
            connection.sendall(b"235 authenticated\r\n")
            if not line(connection).startswith(b"MAIL FROM:<"):
                return
            connection.sendall(b"250 sender ok\r\n")
            recipient_line = line(connection)
            if not recipient_line.startswith(b"RCPT TO:<"):
                return
            recipient = recipient_line[len(b"RCPT TO:<"):-3].decode("ascii")
            attempt = [0]
            def observe(stats):
                stats["recipients"][recipient] = stats["recipients"].get(recipient, 0) + 1
                attempt[0] = stats["recipients"][recipient]
            update(observe)
            if "dead-letter" in recipient:
                update(lambda stats: stats.__setitem__("deadLetter", stats["deadLetter"] + 1))
                connection.sendall(b"550 permanent rejection\r\n")
                return
            if "retry" in recipient and attempt[0] == 1:
                update(lambda stats: stats.__setitem__("temporary", stats["temporary"] + 1))
                connection.sendall(b"421 temporary rejection\r\n")
                return
            connection.sendall(b"250 recipient ok\r\n")
            if line(connection) != b"DATA\r\n":
                return
            connection.sendall(b"354 end with dot\r\n")
            payload = message(connection)
            if b"Content-Transfer-Encoding: base64\r\n" not in payload:
                return
            capture_invitation(payload)
            update(lambda stats: stats.__setitem__("accepted", stats["accepted"] + 1))
            connection.sendall(b"250 accepted\r\n")
            try:
                if line(connection) == b"QUIT\r\n":
                    connection.sendall(b"221 bye\r\n")
            except RuntimeError:
                pass
    finally:
        raw.close()


TLS = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
TLS.load_cert_chain(os.environ["SMTP_CERT"], os.environ["SMTP_KEY"])
listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("0.0.0.0", int(os.environ.get("SMTP_PORT", "8443"))))
listener.listen(32)
while True:
    raw, _ = listener.accept()
    threading.Thread(target=handle, args=(raw,), daemon=True).start()
