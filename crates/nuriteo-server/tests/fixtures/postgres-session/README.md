# ID-005 PostgreSQL session fixture

Run `./run.sh` to start the pinned PostgreSQL image with a fixture-local TLS CA and execute the ignored session lifecycle test. The fixture covers issue, authenticate, wrong and expired credentials, atomic concurrent rotation, replay rejection, idempotent single/all revocation, active-user enforcement, and hash-only persistence.
