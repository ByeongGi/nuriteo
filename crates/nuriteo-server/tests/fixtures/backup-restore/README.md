# Backup restore integration fixture

This fixture starts pinned PostgreSQL and RustFS containers with locally generated TLS certificates.
It creates separate source and restore databases plus separate primary, backup, and restore buckets,
then runs the ignored `backup_restore` integration test.

Run it from the repository root:

```sh
./crates/nuriteo-server/tests/fixtures/backup-restore/run.sh
```

The test exercises an encrypted remote backup, a verified staging read, the public
`backup drill <backup-id>` CLI against an empty isolated PostgreSQL database and bucket, immutable
bundle restoration, session revocation, limited recovery without a Recovery Kit, and rejection of
a populated restore target. It also proves that corrupt manifests and missing payloads fail closed.
