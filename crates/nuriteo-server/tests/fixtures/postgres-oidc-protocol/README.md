# PostgreSQL + OIDC protocol fixture

Runs migration 0030 against digest-pinned PostgreSQL over a generated CA and
serves deterministic OIDC discovery/JWKS documents over a separate generated
TLS endpoint. The test-only loopback allowance is compiled only into the Rust
test target; the production constructor always rejects loopback, private,
link-local, metadata and mixed DNS answers.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-oidc-protocol/run.sh
```
