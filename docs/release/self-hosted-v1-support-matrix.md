# Self-hosted v1 지원·호환성 표

검토일: 2026-10-12  
정본: `compat/self-hosted-v1-support-matrix.json`

이 문서는 NURITEO self-hosted v1의 배포·운영 지원 계약이다. 브라우저 내부 개발 런타임의 세부 호환성은
[지원 매트릭스](./support-matrix.md)를 함께 본다. `candidate`는 GA에서 지원할 목표 범위이지만 아직 필수
실환경 조합 검증이 끝나지 않았다는 뜻이다. `GATE-007`은 모든 필수 candidate가 실제 검증을 통과하기 전에는
GA를 선언하지 않는다.

## 상태 정의

| 상태 | 의미 |
|---|---|
| `supported` | 자동 증거가 연결된 GA 제품 계약 |
| `candidate` | GA 목표 계약이며 `QUAL-001` 통과 전에는 승격할 수 없음 |
| `qualified` | 실제 release rehearsal을 통과한 정확한 환경 |
| `unsupported` | v1 제품 계약 밖의 범위 |

## 지원 계약

| ID | 영역 | 상태 | 계약 | 검증·제약 |
|---|---|---|---|---|
| `SHV1-OCI` | Application images | `candidate` | Server, Web, and Operations OCI images on linux/amd64 and linux/arm64 | REL-001 must prove two clean builds with identical manifest digests on both architectures. |
| `SHV1-COMPOSE-DOCKER` | Single-host Docker Compose | `qualified` | Docker Engine 28.5.1 with Docker Compose 2.40.3 on Linux arm64 | Clean install, restart, upgrade, backup, restore, and application rollback were rehearsed. |
| `SHV1-COMPOSE-PODMAN` | Single-host Podman Compose | `qualified` | Podman 6.0.2 with podman-compose 1.5.0 on macOS arm64 Linux VM | The complete RC aggregate rehearsal passed in this environment. |
| `SHV1-KUBERNETES` | Kubernetes and Helm | `qualified` | Kubernetes 1.29 through 1.37 with Helm 3.14 through 4.2 | Kubernetes 1.29.14 and 1.37.0 endpoints passed actual install, failure fence, upgrade, rollback, uninstall, and Secret-preservation lifecycles with Helm 4.2.2. |
| `SHV1-POSTGRESQL` | PostgreSQL | `qualified` | PostgreSQL 17 and 18 over verified TLS; no optional extension is required | Pinned PostgreSQL 17.11 and 18.1 both passed custom-CA TLS migration serialization, validation, rollback, and retry tests. |
| `SHV1-S3` | Object storage | `supported` | HTTPS S3-compatible storage that passes the NURITEO capability preflight; bundled RustFS 1.0.0 is the single-host default | Compatibility is granted by PUT, GET, HEAD, DELETE, LIST, range, checksum, presign, multipart, and cleanup behavior—not by provider name. |
| `SHV1-BROWSER-CHROME` | Browser | `supported` | Current stable desktop Chrome/Chromium with cross-origin isolation, SharedArrayBuffer, Service Worker, and OPFS | Chrome 154 passed current isolation, SharedArrayBuffer, Service Worker, and OPFS capability qualification; production browser runtime gates remain linked. |
| `SHV1-BROWSER-EDGE` | Browser | `qualified` | Microsoft Edge 155 desktop | COOP/COEP, SharedArrayBuffer, Service Worker, OPFS, and the retained Vite preview smoke passed. |
| `SHV1-BROWSER-SAFARI` | Browser | `qualified` | Safari 26.6.2 on macOS desktop | Isolation, preview, OPFS reopen, and quota recovery smoke passed; iOS and mobile Safari are excluded. |
| `SHV1-AUTH` | Identity | `supported` | Local administrator-managed accounts, expiring invitations, optional TOTP MFA, and multiple instance-wide OIDC providers | WebAuthn/passkeys and public self-registration are not part of v1. |
| `SHV1-UPGRADE` | Upgrade | `qualified` | Forward-only in-place upgrade from the published self-hosted v1 Beta/RC lineage; downgrade is not supported | Beta gate migration 46 and RC.1 migration 50 both passed the upgrade, isolated restore, and application-only rollback matrix; signed artifacts repeat it in QUAL-004. |
| `SHV1-AIRGAP` | Air-gapped installation | `candidate` | Digest-pinned Core Bundle plus optional Quickstart Add-on Bundle imported through an operator-owned OCI registry | The RC Core Bundle plan passed; signed GA artifacts remain REL-002 through REL-005 and QUAL-004 work. |

## 알려진 제한

| ID | 제한 |
|---|---|
| `SHV1-LIMIT-MANAGED` | Managed cloud hosting, billing, and a vendor-operated control plane are not provided. |
| `SHV1-LIMIT-SECRET` | Project secret or environment-variable injection into browser-executed code is not provided. |
| `SHV1-LIMIT-MOBILE` | Mobile browsers, including iOS Safari, are outside the v1 support claim. |
| `SHV1-LIMIT-RUNTIME` | Browser workspaces do not provide Docker, arbitrary Linux binaries, direct TCP databases, or general native Node addons. |
| `SHV1-LIMIT-REGISTRY` | NURITEO is not a package proxy or artifact repository; operators integrate an existing npm registry or repository manager. |
| `SHV1-LIMIT-S3` | S3-compatible means the tested minimum capability contract, not every AWS S3 API or provider-specific feature. |
| `SHV1-LIMIT-DOWNGRADE` | Database downgrade is unsupported; rollback restores a verified pre-upgrade backup when schema compatibility is lost. |
| `SHV1-LIMIT-HA` | The v1 Compose profile is single-host; multi-node high availability requires the Helm production profile and operator-managed PostgreSQL and S3. |

## 지원 판정 원칙

- 제품 이름만으로 호환성을 선언하지 않는다. 정확한 버전 또는 capability test 결과를 기록한다.
- 표에 없는 조합은 동작할 수 있어도 지원 대상으로 주장하지 않는다.
- `candidate`가 하나라도 필수 qualification에서 실패하면 범위를 축소하거나 `GATE-007`을 보류한다.
- 보안 지원 기간과 취약점 대응 절차는 후속 `SUP-004`에서 공개 계약으로 고정한다.
- 새 조합을 추가하거나 제거할 때 JSON 정본과 이 문서를 같은 변경에서 수정하고 parity 검사를 통과해야 한다.
