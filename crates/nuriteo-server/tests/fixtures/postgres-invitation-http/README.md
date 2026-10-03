# INV-003 PostgreSQL HTTP fixture

Run `./run.sh` to start the digest-pinned PostgreSQL image, enable a generated
custom CA TLS identity, and execute the full administrator invitation and public
account activation HTTP journey. The fixture removes its container and TLS
material on exit.
