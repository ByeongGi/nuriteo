# WS-002 Workspace HTTP PostgreSQL fixture

`run.sh` starts the pinned PostgreSQL 17.6 image, installs an ephemeral custom CA/server certificate, and runs the ignored `workspaces_http` integration test against the actual TLS database and application router.

The fixture covers bounded Cookie handling, Personal-first and deterministic active Organization projections, cross-user isolation, archived/removed membership exclusion, missing/duplicate scope fail-closed behavior, generic disabled/expired authentication failures, RFC 9457 responses, request IDs, and response redaction.
