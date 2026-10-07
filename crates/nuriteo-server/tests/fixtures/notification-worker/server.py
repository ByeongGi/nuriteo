import base64
import re
import socket
import ssl
import sys
import threading


def line(connection):
    data = b""
    while not data.endswith(b"\r\n"):
        chunk = connection.recv(1)
        if not chunk or len(data) >= 16384:
            raise RuntimeError("invalid SMTP command")
        data += chunk
    return data


def message(connection):
    data = b""
    while not data.endswith(b"\r\n.\r\n"):
        chunk = connection.recv(4096)
        if not chunk or len(data) >= 131072:
            raise RuntimeError("invalid SMTP message")
        data += chunk
    return data


context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(sys.argv[2], sys.argv[3])
listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", int(sys.argv[1])))
listener.listen(16)
counts = {}
counts_lock = threading.Lock()
print("READY", flush=True)


def handle(raw):
    try:
        with context.wrap_socket(raw, server_side=True) as connection:
            connection.sendall(b"220 fixture ESMTP\r\n")
            if line(connection) != b"EHLO nuriteo.invalid\r\n":
                raise RuntimeError("expected EHLO")
            connection.sendall(b"250-fixture\r\n250 AUTH PLAIN\r\n")
            auth = line(connection)
            if not auth.startswith(b"AUTH PLAIN "):
                raise RuntimeError("expected AUTH")
            decoded = base64.b64decode(auth[len(b"AUTH PLAIN ") :].strip(), validate=True)
            if decoded != b"\0fixture-user\0fixture-password-sensitive":
                connection.sendall(b"535 rejected\r\n")
                return
            connection.sendall(b"235 authenticated\r\n")
            sender = line(connection)
            if re.fullmatch(rb"MAIL FROM:<[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+>\r\n", sender) is None:
                raise RuntimeError("expected MAIL")
            connection.sendall(b"250 sender ok\r\n")
            recipient = line(connection)
            if re.fullmatch(rb"RCPT TO:<[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+>\r\n", recipient) is None:
                raise RuntimeError("expected RCPT")
            address = recipient[len(b"RCPT TO:<") : -3].decode("ascii")
            with counts_lock:
                counts[address] = counts.get(address, 0) + 1
                attempt = counts[address]
            if address == "permanent@example.test":
                connection.sendall(b"550 permanent fixture detail-sensitive\r\n")
                return
            if address == "retry@example.test" and attempt == 1:
                connection.sendall(b"421 temporary fixture detail-sensitive\r\n")
                return
            connection.sendall(b"250 recipient ok\r\n")
            if line(connection) != b"DATA\r\n":
                raise RuntimeError("expected DATA")
            connection.sendall(b"354 end with dot\r\n")
            payload = message(connection)
            if b"Content-Transfer-Encoding: base64\r\n" not in payload:
                raise RuntimeError("body must use base64 MIME transport")
            if b"fixture-body-sensitive" in payload:
                raise RuntimeError("raw UTF-8 body crossed MIME encoding boundary")
            wire = payload[: -len(b"\r\n.\r\n")]
            headers, encoded_body = wire.split(b"\r\n\r\n", 1)
            if not headers.isascii():
                raise RuntimeError("headers must remain ASCII")
            if b"From: =?UTF-8?B?" not in headers or b"Subject: =?UTF-8?B?" not in headers:
                raise RuntimeError("display name and subject must use RFC 2047")
            body_lines = encoded_body.split(b"\r\n")
            if any(not part or len(part) > 76 for part in body_lines):
                raise RuntimeError("invalid MIME base64 line")
            decoded_body = base64.b64decode(b"".join(body_lines), validate=True)
            if not (
                b"fixture-body-sensitive" in decoded_body
                or decoded_body == b"bounded body"
            ):
                raise RuntimeError("unexpected decoded body")
            if address == "ambiguous@example.test":
                return
            connection.sendall(b"250 accepted\r\n")
            try:
                if line(connection) == b"QUIT\r\n":
                    connection.sendall(b"221 bye\r\n")
            except RuntimeError:
                pass
    finally:
        raw.close()


while True:
    raw, _ = listener.accept()
    threading.Thread(target=handle, args=(raw,), daemon=True).start()
