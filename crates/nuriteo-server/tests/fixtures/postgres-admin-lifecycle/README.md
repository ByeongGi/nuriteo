# ADM-001 PostgreSQL fixture

Runs the administrator lifecycle service and database invariants against the pinned PostgreSQL
image with a generated private CA. The fixture covers recent reauthentication, last-admin and
last-active-owner protection, concurrent demotion, atomic audit writes, user disable/reactivate,
session revocation and membership preservation.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-admin-lifecycle/run.sh
```
