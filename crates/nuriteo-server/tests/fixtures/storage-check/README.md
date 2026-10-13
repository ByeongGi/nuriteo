# S3-004 storage-check fixture

`run.sh` starts the fixed RustFS image with a disposable private CA, then runs the real
`nuriteo-server storage-check` subprocess in both transport modes. Relay succeeds without
bucket CORS and ignores a drifted browser CORS document; direct fails until the exact CORS
document is installed and its real OPTIONS probes succeed. Missing buckets, invalid
credentials, and missing or non-exact transport values fail closed. The Rust test asserts
the safe JSON/exit contract and verifies that no object or multipart upload remains below
the reserved probe namespace.
