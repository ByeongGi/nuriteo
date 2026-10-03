# WS-003 Personal Workspace HTTP PostgreSQL fixture

`run.sh` starts the pinned PostgreSQL 17.6 image, installs an ephemeral custom CA/server certificate, and runs the ignored `workspaces_http` integration test against the actual TLS database and application router.

The fixture covers bounded Cookie handling, active Personal projection, generic disabled/expired authentication failures, missing/duplicate scope fail-closed behavior, RFC 9457 responses, request IDs, and response redaction.
