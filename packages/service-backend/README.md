# Service Backend

> **Lifecycle: REFERENCE-ONLY.** This TypeScript backend is retained as the
> domain-contract and regression-fixture reference for the Rust Core API
> transition. It is not the production backend for the Self-hosted service.

## Reference-only contract

Allowed changes are limited to regression fixes needed to keep the canonical
suite trustworthy and extracting contracts, scenarios, or fixtures into the
new implementation. Do not add new product features, persistence adapters, or
deployment responsibilities to this package. New server behavior belongs in
`crates/nuriteo-server`, and browser-facing wire types belong in
`packages/api-client`.

Existing tests, compatibility evidence, and migration tooling may continue to
read this package. New production code in `apps/web`, `packages/api-client`, or
`crates/nuriteo-server` must not import or take a path dependency on
`packages/service-backend` or `@nuriteo/service-backend`.

Removal is allowed only after the Rust API and persistence implementation have
replacement contract fixtures and the applicable Self-hosted acceptance gate
has passed. Historical evidence may then be archived independently.
