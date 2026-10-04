# SAVE-006 actual fixture

Runs the atomic Working Head commit contract against custom-CA PostgreSQL and
HTTPS RustFS. It covers concurrent idempotent commit, authoritative
reconciliation, head replacement/GC enqueue, stale Project fencing, missing
objects, bounded HEAD mismatch, permission revocation, expiry release, checksum
deduplication and cleanup ownership without logging storage keys or bearer URLs.
