# PostgreSQL + OIDC protocol fixture

Runs migrations 0030 and 0032 against digest-pinned PostgreSQL over a generated
CA and serves deterministic OIDC discovery, JWKS and authorization-code token
responses over a separate generated TLS endpoint. A fixture-only RSA key signs
ID Tokens and the token endpoint independently checks the received PKCE
verifier. The test-only loopback allowance is compiled only into the Rust test
target; the production constructor always rejects loopback, private,
link-local, metadata and mixed DNS answers.

```sh
./crates/nuriteo-server/tests/fixtures/postgres-oidc-protocol/run.sh
```
