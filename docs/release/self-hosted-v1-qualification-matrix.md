# Self-hosted v1 실환경 Qualification Matrix

검증일: 2026-10-12  
정본: `compat/self-hosted-v1-qualification-matrix.json`

지원 경계별 독립 process/protocol을 검증한다. PostgreSQL·S3·Kubernetes·브라우저의 무의미한 전체 Cartesian
product는 만들지 않는다. 대신 각 지원 major 또는 범위의 양 끝과 browser capability를 실제 환경에서
실행한다. 표의 모든 필수 행이 `actual/pass`여야 `QUAL-001`을 통과한다.

| ID | 실제 환경 | 핵심 결과 |
|---|---|---|
| `postgresql-17` | PostgreSQL 17.11 linux/arm64, custom-CA TLS | migration serialization·validation·rollback·retry PASS |
| `postgresql-18` | PostgreSQL 18.1 linux/arm64, custom-CA TLS | migration serialization·validation·rollback·retry PASS |
| `s3-compatible` | pinned RustFS, custom-CA HTTPS | PUT/GET/HEAD/DELETE/LIST/range/checksum/presign/multipart/cleanup PASS |
| `kubernetes-1.29` | kind Kubernetes 1.29.14, Helm 4.2.2 | install/failure fence/upgrade/rollback/uninstall/Secret preservation PASS |
| `kubernetes-1.37` | kind Kubernetes 1.37.0, Helm 4.2.2 | install/failure fence/upgrade/rollback/uninstall/Secret preservation PASS |
| `chrome-desktop` | Google Chrome 154.0.8037.98, macOS | isolation/SAB/Service Worker/OPFS PASS |
| `edge-desktop` | Microsoft Edge 155.0.4283.45, macOS | isolation/SAB/Service Worker/OPFS PASS |
| `safari-desktop` | Safari 26.6.2, macOS | isolation/SAB/Service Worker/Vite Preview/OPFS/quota recovery PASS |

## 재검증 명령

- PostgreSQL: `crates/nuriteo-server/tests/fixtures/postgres-migrations/run.sh`에 고정 image digest와 별도 port를 전달한다.
- S3 Compatible: `crates/nuriteo-server/tests/fixtures/run-rustfs-capabilities.sh`
- Kubernetes: `charts/nuriteo/tests/kind-release.sh`에 고정 kind node image, 고유 cluster/namespace를 전달한다.
- Chrome/Edge: `tooling/qualification/browser-capabilities.ts`에 browser product와 executable을 전달한다.
- Safari: `compat/browser-smoke-results.json`의 동일 26.6.2 실제 WebDriver 결과를 사용한다. 모바일 Safari는 제외한다.

외부 S3 제품은 제품명으로 지원하지 않고 설치 시 동일 capability preflight를 통과해야 한다. 환경 범위나
major를 바꾸면 이 표, 지원 표, 고정 artifact identity와 실제 실행 결과를 같은 변경에서 갱신한다.
