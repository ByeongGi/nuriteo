# Self-hosted v1 운영 Runbook

이 문서는 NURITEO self-hosted v1의 설치, 업그레이드·롤백, 백업·복구, 사고 대응 절차를 한 곳에 모은다.
명령 정본은 `compat/self-hosted-runbooks-v1.json`이며 `pnpm check:self-hosted-runbooks`가 문서와 명령의
일치를 검사한다. 운영 대상 release의 manifest와 image digest를 먼저 확인하고, production 변경 전에는
별도 staging 또는 격리 복구 환경에서 같은 절차를 실행한다.

## Compose 설치

대상: 개인·소규모 팀의 단일 호스트. 외부 공개 포트는 Web만 허용하고 PostgreSQL, Core, RustFS는 내부
network에 둔다. credential 및 TLS key 파일은 owner-only 권한으로 준비한다.

1. `deploy/compose/README.md`의 필수 Secret과 TLS 파일을 준비한다.
2. release manifest에 고정된 Server/Web/Operations image digest를 확인한다.
3. clean volume에서 설치한 뒤 bootstrap administrator로 로그인한다.
4. 같은 volume 재시작 후 Project Save/Resume와 DB/object sentinel을 확인한다.
5. one-shot init 또는 preflight가 실패하면 Core/Web이 시작하지 않아야 한다.

<!-- runbook-command:install-compose -->
```sh
NURITEO_COMPOSE_PROVIDER=uvx deploy/compose/test-compose.sh
```

실패 시 `NURITEO_COMPOSE_KEEP=1`은 격리된 시험 환경 진단에만 사용한다. 운영 데이터를 대상으로 시험 script를
실행하지 않는다.

## Helm 설치

대상: Kubernetes production profile. 운영자 소유 PostgreSQL과 HTTPS S3-compatible storage, wildcard
Preview DNS/TLS, ingress와 Secret을 먼저 준비한다. Chart가 소유하지 않는 Secret은 uninstall 후에도 유지한다.

1. `helm lint`와 render에서 digest-only image, non-root/read-only/capability drop을 확인한다.
2. migration, storage preflight, bootstrap hook 성공 뒤 workload가 Ready가 되는지 확인한다.
3. restricted Pod Security와 default-deny NetworkPolicy를 적용한다.
4. 실패 hook이 application rollout을 차단하는지 확인한다.
5. uninstall 뒤 operator-owned Secret과 외부 데이터가 보존되는지 확인한다.

<!-- runbook-command:install-helm -->
```sh
charts/nuriteo/tests/kind-release.sh
```

## 업그레이드와 Application Rollback

업그레이드는 forward-only다. 이전 image로 되돌리는 application rollback은 현재 schema/object format을 이전
application이 읽을 수 있을 때만 허용하며 database down migration을 실행하지 않는다.

1. 최신 `complete` backup과 별도 Master Key/recovery kit를 확인한다.
2. source/target release set과 compatibility manifest의 hash를 고정한다.
3. read-only preflight와 Object Storage capability check를 실행한다.
4. migration 후 Core, Web 순서로 교체하고 readiness와 사용자 여정을 확인한다.
5. application readiness 실패 시 호환 가능한 이전 Core/Web 쌍으로만 되돌린다.
6. schema/object rollback이 필요하면 이전 application을 억지로 시작하지 말고 전체 restore를 수행한다.

<!-- runbook-command:upgrade-rollback -->
```sh
deploy/compose/run-upgrade-rehearsal.sh
```

## Backup과 격리 Restore

PostgreSQL dump만으로는 공식 restore point가 아니다. `complete` manifest, DB archive, object payload, checksum과
외부 Master Key/recovery kit가 함께 필요하다. restore는 production과 다른 빈 DB와 빈 bucket에서 먼저 한다.

1. 최근 성공 시각, `complete` 상태, manifest signature/checksum을 확인한다.
2. 백업 destination과 분리된 scratch PostgreSQL/S3를 준비한다.
3. manifest가 요구하는 release, PostgreSQL major, schema, 외부 Secret 목록을 preflight한다.
4. archive와 모든 object의 크기/checksum을 검증한 뒤 빈 target에 복구한다.
5. 로그인, Workspace/Project, 저장된 Bundle, audit reference와 backup reference를 확인한다.
6. 성공한 격리 복구 결과와 RPO/RTO를 기록한 뒤에만 production 복구를 승인한다.

<!-- runbook-command:backup-restore -->
```sh
CONTAINER_RUNTIME=podman crates/nuriteo-server/tests/fixtures/backup-restore/run.sh
```

## Incident Triage

1. 사용자에게 UTC 발생 시각과 화면의 request reference/operation ID를 받는다.
2. Operations 화면에서 dependency/queue 상태를 확인하고 Support Bundle을 수동 생성한다.
3. release manifest와 artifact digest가 배포 상태와 일치하는지 확인한다.
4. credential 노출이 의심되면 공개 채널에 Bundle이나 token을 게시하지 말고 즉시 회전·폐기 범위를 정한다.
5. `docs/release/incident-playbook.md`의 severity/owner/응답 목표로 분류하고 사용자 공지를 시작한다.
6. 완화 후 동일 operation을 재현하고 health, audit, log/trace correlation과 데이터 무결성을 확인한다.

<!-- runbook-command:incident-triage -->
```sh
pnpm check:incident-playbook && pnpm check:self-hosted-support-bundle
```

## 공통 종료 기준

- 실행 명령과 UTC 시각, release/source commit, artifact digest, 환경 version을 기록한다.
- 임시 cluster/container/volume과 secret-bearing directory를 정리한다.
- 실패를 성공으로 바꾸기 위해 검사를 생략하거나 지원 범위를 넓히지 않는다.
- 실행 결과가 문서와 다르면 production 변경을 중지하고 문서·정책·자동 검사를 같은 변경에서 수정한다.
