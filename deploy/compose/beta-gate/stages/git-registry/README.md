# GATE-005 Git and Registry live stages

These stages are intentionally additive. They never migrate, truncate, reset, or drop the live database. Capture `sentinels.sql` before setup and after every assertion, and reject the run unless the JSON values are byte-for-byte equivalent.

## Provider requirements

Run one `provider.py --mode git` and two `provider.py --mode registry` services. Give them distinct stats files and ephemeral tokens. The Git root must contain a writable bare `repo.git` with `main` and `http.receivepack=true`.

Production outbound policy rejects loopback, private, link-local, documentation, and metadata addresses. The Compose-only provider network therefore needs a test-only, public-looking static subnet which is not routed outside the project. Attach Core, the harness, and providers only to that isolated network. Generate the fixture leaf with the exact provider DNS names/IPs in its SAN. Do not weaken Core TLS or address validation.

Core and the harness must receive the same `NURITEO_MASTER_KEY_FILE` and `NURITEO_MASTER_KEY_VERSION=1`. Mount the database URL/CA into the harness. The harness receives only the public provider CA file read-only; it has no provider token, private key, or provider TLS directory mount. Its Registry gateway reads active CA trust through the encrypted production integration repository. The driver proves that an active, recently reauthenticated administrator Session already exists but does not create or rewrite identity rows.

## Invocation order

The common driver should call `run.sh` once after the existing administrator browser journey has produced a recently reauthenticated Session. The provider override must define a `gate-harness` service whose entrypoint is the compiled `harness` binary. Set `NURITEO_BETA_GATE_HARNESS_DIR` to the same private host directory used as `NURITEO_GATE_STAGE_ROOT`; only that directory is mounted read-write at `/run/gate-state`. Mount the database URL/CA and Master Key secrets at their declared harness paths, and attach it to both the data and isolated provider networks. Assertion files are written to `NURITEO_GATE_ASSERTION_DIRECTORY` (or that stage root by default).

`run.sh` performs the following sequence internally:

1. Execute `sentinels.sql` into `sentinels-before.json` and separately prove the existing object-lineage sentinel is readable from RustFS.
2. Run `browser-stage.ts` with `NURITEO_GATE_GIT_REGISTRY_PHASE=configure`. Through live Web/Core HTTP it creates the disabled Git Provider and exact/default Registry candidates, then uses the common Integration CA lifecycle to list, stage, preflight, and activate custom CA trust for each exact integration. Every CA mutation proves its strong ETag and supplies Origin, CSRF, and a unique idempotency key. Finally it validates and activates the Git Provider through its admin lifecycle API. Separate temporary Git and Registry records must also complete create/update-or-rotate/delete, disappear from the collection, and never return their credentials; these calls assert the exact Web BFF `no-store` boundary.
3. Run `browser-stage.ts` with phase `exercise`. It performs Registry activate/default/exact-scope mutations and Git connect, import, pull, commit-and-push, and non-fast-forward rejection through live HTTP.
4. Run the harness with `NURITEO_GATE_HARNESS_COMMAND=registry-fetch`, package `@gate/exact`, and a private metadata output file. This is the production `RegistryGatewayService` data-plane request path. Use `fetch-provider.mjs tarball` to fetch its exact `dist.tarball` with the same custom CA/token and retain bytes for integrity verification.
5. Snapshot default Registry stats, run the browser stage with phase `disable-exact`, run the harness with `registry-expect-no-fallback`, then snapshot default stats again. Exact equality proves no fallback request occurred.
6. Execute `git-lineage.sql` for the original Project, HEAD the returned object key in the original RustFS bucket, and execute `sentinels.sql` again. Run `assertions.mjs`; it writes the two assertion arrays consumed by the common evidence recorder.

The harness is restricted to Registry data-plane metadata resolution and explicit no-fallback verification, for which no browser administration route is appropriate. Git Provider and common Integration CA lifecycle mutations, user Git credentials, and Registry administration all use live Web/Core HTTP. No stage writes active rows with SQL.

## Required browser-stage values

Besides the common beta-gate origin, admin password, context, and private state paths:

- `NURITEO_GATE_GIT_HOST`, `NURITEO_GATE_GIT_TOKEN`, `NURITEO_GATE_GIT_REPOSITORY_URL`, `NURITEO_GATE_GIT_CONTROL_URL`
- `NURITEO_GATE_REGISTRY_EXACT_URL`, `NURITEO_GATE_REGISTRY_EXACT_TOKEN`
- `NURITEO_GATE_REGISTRY_DEFAULT_URL`, `NURITEO_GATE_REGISTRY_DEFAULT_TOKEN`
- `NURITEO_GATE_PROVIDER_CA_FILE`

Never include tokens, PEM, database URLs, object keys, metadata bodies, or stage state in report-bound logs. Only the assertion JSON produced by `assertions.mjs` is safe to record.
