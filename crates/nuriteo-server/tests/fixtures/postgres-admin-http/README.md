# ADM-002 PostgreSQL HTTP fixture

Runs the administrator settings and status API against the pinned PostgreSQL image with a
generated private CA. The fixture covers authentication, administrator authorization, CSRF,
recent reauthentication, strong ETag concurrency, registry validation, atomic audit persistence,
secret-free responses and status projection.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-admin-http/run.sh
```
