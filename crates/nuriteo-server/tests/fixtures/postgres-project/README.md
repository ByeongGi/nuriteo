# PRJ-001 PostgreSQL Project schema fixture

`run.sh` starts the pinned PostgreSQL 17.6 image, installs an ephemeral custom
CA/server certificate, and runs migration 1..12 plus the focused Project schema
test against the actual TLS database.

The fixture covers User and Organization owner/scope identity, independent slug
namespaces, lifecycle/version/timestamp constraints, permanent tombstone URL
reservation, transaction rollback, repeated migration, readiness, and the
nullable verified-Bundle `working_head_bundle_id` added by SAVE-001 without
weakening the original Project invariants.
