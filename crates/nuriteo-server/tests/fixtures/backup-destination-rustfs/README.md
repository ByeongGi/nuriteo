# BKP-003 HTTPS S3-compatible destination fixture

`run.sh` starts the repository-pinned RustFS image with a private test CA. The
fixture installs a bucket policy that explicitly denies object deletion under
the backup prefix, then verifies the exact static writer credential can
write/read/list an SSE-S3 object while delete remains denied. It also proves an
invalid credential fails closed without appearing in the returned error.

The script removes the container and generated CA on exit.
