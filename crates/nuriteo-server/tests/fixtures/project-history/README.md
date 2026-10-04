# SAVE-012 Project history fixture

Run `./run.sh` with Podman or Docker available. The shared pinned fixture starts
custom-CA PostgreSQL and HTTPS RustFS on dynamic loopback ports, then creates
four admitted Bundles through actual presigned PUT, verification, and Working
Head commits before exercising Recovery listing and atomic history promotion.

The test covers oldest-checkpoint rotation, durable same-key replay and
reconcile, explicit-Version no-op promotion, stale ETag rejection, archived
read access, archived mutation rejection, audit cardinality, and distinct live
Bundle quota projection.
