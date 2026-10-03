# S3-004 storage-check fixture

`run.sh` starts the fixed RustFS image with a disposable private CA, then runs the real
`nuriteo-server storage-check` subprocess against an existing bucket, a missing bucket,
and invalid credentials. The Rust test asserts the safe JSON/exit contract and verifies
that no object or multipart upload remains below the reserved probe namespace.
