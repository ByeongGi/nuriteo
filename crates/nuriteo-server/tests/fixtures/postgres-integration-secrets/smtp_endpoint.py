import socket
import ssl
import sys
import threading


context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(sys.argv[2], sys.argv[3])
listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", int(sys.argv[1])))
listener.listen(8)


def handle(raw):
    try:
        with context.wrap_socket(raw, server_side=True) as connection:
            connection.sendall(b"220 integration endpoint ESMTP\r\n")
            command = b""
            while not command.endswith(b"\r\n") and len(command) <= 512:
                chunk = connection.recv(1)
                if not chunk:
                    return
                command += chunk
            if command == b"EHLO nuriteo.invalid\r\n":
                connection.sendall(b"250 integration endpoint\r\n")
    finally:
        raw.close()


while True:
    raw, _ = listener.accept()
    threading.Thread(target=handle, args=(raw,), daemon=True).start()
