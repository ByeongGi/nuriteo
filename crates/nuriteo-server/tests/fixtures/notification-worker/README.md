# NOT-002 notification worker fixture

`run.sh` starts the digest-pinned PostgreSQL image and a bounded local implicit-TLS SMTP stub under
one ephemeral custom CA. It applies the canonical migration chain through 0027 and exercises replica-safe
claiming, an expired-lease crash recovery, an explicit 4xx retry followed by acceptance, immediate 5xx
dead-lettering, post-DATA ambiguous classification, stale-recipient cancellation, MIME/header safety, and
supervised graceful shutdown. The script removes its container, credentials, certificates, and logs on exit.
