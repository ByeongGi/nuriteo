import base64
import socket
import ssl
import sys


def line(connection):
    data = b""
    while not data.endswith(b"\r\n"):
        chunk = connection.recv(1)
        if not chunk or len(data) >= 16384:
            raise RuntimeError("invalid SMTP command")
        data += chunk
    return data


context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(sys.argv[2], sys.argv[3])
listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", int(sys.argv[1])))
listener.listen(1)
print("READY", flush=True)
raw, _ = listener.accept()
try:
  connection_context = context.wrap_socket(raw, server_side=True)
except ssl.SSLError:
  if len(sys.argv) > 4 and sys.argv[4] == "allow-handshake-failure":
    sys.exit(0)
  raise
with connection_context as connection:
    connection.sendall(b"220 fixture ESMTP\r\n")
    if line(connection) != b"EHLO nuriteo.invalid\r\n":
        raise RuntimeError("expected EHLO")
    connection.sendall(b"250-fixture\r\n250 AUTH PLAIN\r\n")
    auth = line(connection)
    if not auth.startswith(b"AUTH PLAIN "):
        raise RuntimeError("expected AUTH PLAIN")
    decoded = base64.b64decode(auth[len(b"AUTH PLAIN ") :].strip(), validate=True)
    if len(sys.argv) > 4 and sys.argv[4] == "reject-auth":
        connection.sendall(b"535 fixture-password-sensitive rejected\r\n")
        sys.exit(0)
    if decoded != b"\0fixture-user\0fixture-password-sensitive":
        connection.sendall(b"535 authentication rejected\r\n")
        raise RuntimeError("unexpected credentials")
    connection.sendall(b"235 authenticated\r\n")
    if line(connection) != b"QUIT\r\n":
        raise RuntimeError("expected QUIT")
    connection.sendall(b"221 bye\r\n")
