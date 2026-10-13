# SAVE-005 staging verifier fixture

Runs the ignored SAVE-005 integration test against pinned PostgreSQL and
RustFS containers, both configured with fixture-local certificate authorities.
It covers canonical BND-001 verification, concurrent retry, corrupt padding,
terminal cleanup convergence, and absolute-deadline lock timeout behavior.

```sh
./crates/nuriteo-server/tests/fixtures/staging-verifier/run.sh
```
