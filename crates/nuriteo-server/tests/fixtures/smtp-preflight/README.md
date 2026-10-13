# SMTP preflight fixture

`run.sh` creates a short-lived CA and `localhost` server certificate, starts a bounded local TLS SMTP
stub, and runs the ignored `smtp_preflight` integration test. The fixture proves hostname and custom-CA
verification, implicit TLS, AUTH PLAIN credential use through `_FILE` sources, and successful protocol
preflight. All keys, credential files, logs, and temporary processes are removed on exit.
