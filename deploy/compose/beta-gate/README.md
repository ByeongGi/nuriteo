# GATE-005 clean-Compose aggregate contract

This directory is the fail-closed entry point for the Beta aggregate. It does not turn the
independent task fixtures into a false aggregate result. The final reviewed driver must install a
clean Compose project and execute every stage in `contract.json` against that same project and
database lineage.

## Commands

```text
deploy/compose/beta-gate/run.sh inventory
NURITEO_BETA_GATE_RELEASE_COMMIT=<full-commit> deploy/compose/beta-gate/run.sh preflight
NURITEO_BETA_GATE_RELEASE_COMMIT=<full-commit> \
  deploy/compose/beta-gate/run.sh acceptance
deploy/compose/beta-gate/run.sh self-test
```

`inventory` is non-mutating and reports unfinished predecessor evidence. `preflight` additionally
requires a clean tree, an exact full release commit, the immutable Alpha ancestor, and the Beta
baseline check. `acceptance` refuses to run without a repository-owned executable driver and
validates its report before printing the pass marker.

`acceptance` uses the repository-owned `acceptance-driver.sh`; external driver substitution is not
accepted. The driver creates one random Compose project, performs the implemented live
API/browser boundaries, and refuses to
restart or write a report unless `check-journey.mjs` finds every required live stage. The provider
overlay adds isolated OIDC, Registry, Git HTTPS, and SMTP endpoints on the same Compose network. It
never treats an independent PostgreSQL or browser fixture result as aggregate evidence.

## Fail-closed boundary

The driver contains same-install journeys for OIDC authorization code with PKCE, live SMTP
delivery/retry/dead-letter, smart-HTTPS Git operations, exact-scope Registry resolution without
fallback, and anonymous fixed-version Preview isolation. They only become release evidence when
the complete driver passes from a clean exact commit. Independent fixtures and partially completed
stages never satisfy the aggregate.

After the same-volume down/up, the driver does more than compare storage sentinels: it rechecks the
revoked PAT, completes a fresh OIDC login, performs a Git pull with the persisted credential and CA,
reactivates and fetches through the persisted exact Registry, verifies terminal SMTP delivery state,
and runs the public Preview journey again. Administrative and public boundaries also assert their
exact no-store/revalidation, redaction, and isolation headers.

## Driver report

The driver receives `NURITEO_BETA_GATE_RELEASE_COMMIT` and
`NURITEO_BETA_GATE_REPORT_FILE`. It must write JSON matching `contract.json`, including immutable
digests and source-commit labels for the PostgreSQL, Server, and Web images. Every stage needs a
stable, secret-free evidence reference and SHA-256. The validator opens every evidence file and
checks its release commit, Compose project, database lineage, object lineage, stage identity, and
runtime assertions. Raw browser/process logs, credentials, invitation tokens,
OIDC assertions, Git/Registry tokens, and signed Preview capabilities must not be copied into the
report.

Cleanup must target only the random GATE-005 Compose project and its temporary directory. The
driver must never use global container/image/builder pruning.

Set `NURITEO_BETA_GATE_KEEP=1` only for an operator-led failed-run investigation. The driver prints
the exact random project and private temporary directory; cleanup remains the operator's
responsibility in that mode.

## Existing assertions to reuse

These fixtures are useful implementation inputs, but running them separately is not aggregate
evidence. The driver should move their assertions into the live clean-Compose journey or invoke an
adapter against the already running gate project.

| Gate stage | Existing assertion source | Aggregate work still required |
|---|---|---|
| Alpha install/persistence | `deploy/compose/test-compose.sh`, `relay-save-resume-browser.ts` | expose a reviewed in-stack extension point before cleanup |
| Administrator/control plane | `postgres-admin-http`, Web admin settings browser tests | use the bootstrapped gate administrator and verify reauthentication/audit |
| OIDC | `postgres-oidc-protocol`, `postgres-oidc-providers`, OIDC browser test | start the provider inside the isolated gate network and complete invited-user login |
| MFA | `postgres-mfa-totp`, `postgres-mfa-challenge`, MFA browser test | apply the gate policy to the local user without replacing the installation |
| Team | `postgres-team-http`, Team browser test | reuse the same Organization, members, Workspace, and Project |
| Policy | `postgres-policy-engine`, admin settings browser test | prove preview/apply/effective values and restore a deterministic value |
| Notifications | `notification-worker`, notification browser test | run SMTP sink/retry/dead-letter on the same database and domain mutations |
| Git | `git-https` fixture and GIT-002 browser/API tests | implemented by the in-network HTTPS provider and live browser/Core lifecycle |
| Registry | `postgres-registry-gateway`, registry browser test | implemented with exact/default HTTPS providers, fail-closed routing, and redaction checks |
| Publish/Fork | `published-example-fork`, published Example browser test | publish the gate Project, fork into a distinct owner/Bundle, then read independently |
| Public Preview | published Preview isolation browser test | bind the immutable gate Version on the wildcard public Preview origin |

The actual driver also needs one redaction ledger covering Core, Web, provider, browser request, and
report output; independent fixture-specific scans are not sufficient for the final `secret-scan`
stage.
