# Self-hosted v1 Upgrade·Restore·Rollback Matrix

검증일: 2026-10-12  
정본: `compat/self-hosted-v1-lifecycle-matrix.json`

v1 GA가 지원하는 source는 같은 release 계보의 Beta gate와 `1.0.0-rc.1`이다. Upgrade는 forward-only이고
rollback은 현재 schema/object를 보존한 application rollback이다. DB schema를 과거로 돌려야 하는 장애는
down migration 대신 upgrade 전 검증 backup을 빈 PostgreSQL/S3 target에 full restore한다.

| Source | Schema | Upgrade | Restore | Rollback |
|---|---:|---|---|---|
| `self-hosted-beta-gate-005` | 46 → 50 | actual PostgreSQL + digest-pinned Compose PASS | encrypted isolated restore PASS | source app, schema 50/object 보존 PASS |
| `1.0.0-rc.1` | 50 → 50 | RC clean lifecycle + immutable prefix/no-op schema PASS | encrypted isolated restore PASS | RC-compatible app, schema/object 보존 PASS |

## 공통 실패 경계

- preflight 또는 object capability 실패는 workload와 schema 변경 전에 중단한다.
- migration 이후 application readiness 실패는 source-compatible application으로 복귀하되 down migration을
  실행하지 않는다.
- restore는 production과 다른 빈 database/bucket에서만 허용한다.
- populated target, 손상 manifest, 누락 payload는 target mutation 전에 거부한다.
- 기존 object는 upgrade 중 rewrite하지 않고 byte-identical하게 read in place한다.

이 표는 source release별 data contract를 검증한다. 최종 signed GA image/chart/bundle의 clean install부터
upgrade·backup·restore까지의 연결은 `QUAL-004`에서 같은 절차로 다시 실행한다.
