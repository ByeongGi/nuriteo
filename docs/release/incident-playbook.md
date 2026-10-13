# Incident Playbook

날짜: 2026-10-12

Self-hosted v1의 공개 신고 경로, 지원 release, severity와 coordinated disclosure 정본은
[취약점·Incident·지원 대응](../security/vulnerability-and-incident-response.md)을 따른다.

## 원칙

장애 대응은 재현 가능한 support bundle, release fingerprint, known limitations를 함께 본다. 사용자가 개발 세션을 잃지 않도록 project snapshot과 archive export를 우선 보존하고, unsupported scope는 성공처럼 숨기지 않는다.

## Incident Matrix

| 유형 | 심각도 | Owner | 주요 신호 | 우선 조치 |
|---|---|---|---|---|
| rollback | high | release-owner | PG regression, support bundle error spike, artifact fingerprint mismatch | promotion 중단, rollback artifact 복구, provenance/smoke 재실행 |
| browser-regression | high | runtime-owner | SharedArrayBuffer unavailable, COOP/COEP drift, worker boot failure | known-good browser matrix 고정, 영향 버전 공지, runtime workaround 또는 release hold |
| registry-outage | medium | package-runtime-owner | registry timeout, integrity fetch failure, install retry spike | verified cache 사용, offline diagnostic 노출, backoff retry |
| quota-corruption | medium | storage-owner | `EOPFSQUOTA`, snapshot recovery failure, lease conflict spike | latest valid snapshot 보존, cache prefix만 eviction, reset 전 archive export 제공 |
| security-report | critical | security-owner | credential leak, permission bypass, CSP regression | private ack, support bundle로 재현, patch/credential rotation, advisory 판단 |

## 사용자 커뮤니케이션 템플릿

### Rollback

We paused this release and rolled back to the previous verified runtime artifact. Existing projects remain available; retry after the status page reports recovery.

### Browser Regression

A browser update is affecting runtime startup. Use a supported Chromium version from the support matrix while we validate a runtime fix.

### Registry Outage

Package registry access is degraded. Cached packages continue to work; new installs may fail until registry connectivity recovers.

### Quota Corruption

Project storage needs recovery. We preserved the latest valid snapshot and will avoid deleting project files unless you explicitly reset the workspace.

### Security Report

We received a security report and are investigating. Do not share tokens or private project archives in public channels; we will provide a patched build or mitigation.

## 대응 목표

| 심각도 | 목표 |
|---|---|
| critical | 4시간 내 접수 확인 |
| high | 영업일 1일 내 triage |
| medium | 영업일 2일 내 triage |

## 필수 첨부

- NURITEO redacted Support Bundle (`docs/operations/support-bundle.md`).
- Release channel/version.
- `docs/release/fingerprint.json`의 artifact fingerprint.
- Browser version과 COOP/COEP header snapshot.
- Package manager command와 registry URL origin.
