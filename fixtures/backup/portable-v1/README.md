# portable-v1 compatibility fixtures

The checked-in manifest schema is canonical. The two `valid-*.manifest.json` documents are public,
stable examples. `cases.json` is the public error-code matrix. The fixture payload bytes are the
UTF-8 strings `PGDMP fixed database` and `immutable bundle payload`; their hashes and lengths are
fixed in the manifests.

`crates/nuriteo-server/tests/backup_engine.rs` builds byte-exact archives from these fixed bytes,
applies each declared adversarial transformation, and checks them with the production importer.
Generating malformed tar headers in the test keeps dangerous path/link/device fixtures out of a
checkout while still fixing their wire bytes and expected error categories in CI.

The matrix covers the minimal valid archive and optional extension, plus traversal, absolute
path, link/device type, duplicate/undeclared entry, unknown required feature, size/checksum
mismatch, truncation, missing object and trailing-data rejection. The valid stream is also listed
by the host POSIX `tar` reader to prove external pax/ustar interchange compatibility.
