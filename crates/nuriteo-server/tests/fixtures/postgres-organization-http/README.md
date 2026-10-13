# ORG-004 PostgreSQL HTTP fixture

Run `./run.sh` to start the digest-pinned PostgreSQL image, install an ephemeral
custom-CA TLS identity, and execute the authenticated Organization HTTP journey.
The fixture removes its container and TLS material on exit.
