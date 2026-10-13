# Artifact Provenance

날짜: 2026-09-15

## 목적

릴리스 artifact는 source commit, package lockfile, Rust lockfile, SDK package output, WASM asset, release fingerprint로 역추적 가능해야 한다. P16-02 기준에서 외부 publish는 아직 수행하지 않지만, internal/beta/stable 채널마다 필요한 provenance 수준을 미리 고정한다.

## 추적 단위

| 항목 | 파일 |
|---|---|
| Source package | `package.json`, `pnpm-lock.yaml`, `Cargo.lock` |
| SDK artifact | `dist/sdk/package/package.json`, `index.js`, `index.cjs`, `index.d.ts`, `asset-manifest.json` |
| Runtime asset | `dist/sdk/package/assets/system_wasm.wasm` |
| Release controls | `docs/release/fingerprint.json`, `compat/release-policy.json`, `compat/performance-baseline.json`, `compat/soak-baseline.json` |

## SBOM/License

`compat/release-provenance.json`은 릴리스에서 반드시 추적해야 하는 component와 license를 machine-readable 형태로 보관한다. 현재 P16-02 scope는 vendored npm/pnpm, runtime dependency인 `fflate`, build dependency인 `typescript`를 최소 SBOM component로 기록한다. P16-04에서는 release checklist가 이 manifest를 최종 release note와 연결한다.

## Signing

- internal: hash-verified artifact만으로 허용한다.
- beta-candidate: hash verification과 maintainer attestation이 필요하다.
- stable: external publish 전에 sigstore 또는 동등한 detached signature가 필요하다.

## CI

`.github/workflows/release-provenance.yml`는 release provenance lane의 기준 명령을 기록한다. CI는 TypeScript check, release policy, performance baseline, soak baseline, `package-sdk`, release readiness(fingerprint drift), provenance, workspace skeleton을 실행해야 한다.

Fingerprint mismatch 복구는 `docs/release/operations.md`의 Fingerprint Recovery를 따른다.
