# Release Operations Checklist

날짜: 2026-09-16

## 결정

PG20 PASS 기준으로 제품은 scoped browser JS/TS development release candidate 상태다. Stable 외부 publish와 registry publish는 허용하되, publish 시점에 이 checklist와 artifact fingerprint를 한 번 더 재확인해야 한다.

## Checklist

| 항목 | 상태 | 증거 |
|---|---|---|
| Release channel/support window | PASS | `docs/release/release-policy.md`, `compat/release-policy.json` |
| Artifact provenance | PASS | `docs/release/provenance.md`, `compat/release-provenance.json`, `tooling/checks/check-release-provenance.ts` |
| SBOM/license minimum report | PASS | `compat/release-provenance.json` |
| Incident/support playbook | PASS | `docs/release/incident-playbook.md`, `compat/incident-playbook.json` |
| Performance/soak gate | PASS | `compat/performance-baseline.json`, `compat/soak-baseline.json` |
| Known limitations | PASS | `docs/release/known-limitations.md` |
| Support matrix | PASS | `docs/release/support-matrix.md` |
| External publish | READY | PG20 PASS. publish 시점 release checklist 재확인 후 진행 |

## Required Commands

```sh
node tooling/release/package-sdk.ts
node tooling/checks/check-sdk-public-release.ts
node tooling/checks/check-sdk-publish-rehearsal.ts
node tooling/checks/check-release-readiness.ts
node tooling/checks/check-release-ops-sg29.ts
node tooling/checks/check-release-policy.ts
node tooling/checks/check-release-provenance.ts
node tooling/checks/check-incident-playbook.ts
node tooling/checks/check-performance-baseline.ts
node tooling/checks/check-soak-baseline.ts
node tooling/checks/check-release-operations.ts
node tooling/checks/check-public-beta-readiness.ts
node tooling/checks/check-workspace.ts
```

SG29 elevates this checklist into a CI gate: packaging + fingerprint readiness + release-ops rehearsal must pass before channel promotion.

Public-beta promotion additionally requires `mise exec node@22.23.0 -- pnpm run check:public-beta-readiness`. The check rejects a `public-beta-ready` decision while the reliability policy still contains held public fixtures or held browsers.

## Launch Boundary

P16 PASS는 운영 체계의 준비 상태를 의미했다. 현재는 PG17 UX, PG18 ecosystem compatibility, PG19 WASM/WASI tooling, PG20 parity acceptance가 모두 통과했으므로 scoped browser JS/TS development release candidate로 판단한다. Stable 외부 publish는 위 checklist와 fingerprint를 publish 시점에 재확인한 뒤 진행한다.
