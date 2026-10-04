# SAVE-012 Project history fixture

Run `./run.sh` with Podman or Docker available. The shared pinned fixture starts
custom-CA PostgreSQL and HTTPS RustFS on dynamic loopback ports, then creates
four admitted Bundles through actual presigned PUT, verification, and Working
Head commits before exercising Recovery listing and atomic history promotion.

The test covers oldest-checkpoint rotation, previous-head recency refresh,
durable same-key replay and reconcile, explicit-Version no-op promotion, stale
ETag rejection, archived read access, archived mutation rejection, audit
cardinality, and distinct live Bundle quota projection. It also rejects direct
promotion-ledger deletion while allowing Project deletion cascade, and repeats
cross-Project shared-Bundle promotions in both directions to exercise globally
ordered evicted/current/target lifecycle locks under actual concurrency.
