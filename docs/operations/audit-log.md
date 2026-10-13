# Audit log operations

Audit Event의 source of truth는 PostgreSQL이다. 조회와 수동 export·preview·prune는 Instance 관리자
화면/API에서 수행하고, 만료 Event의 일상 정리는 Core에 포함된 policy-maintenance worker가 담당한다.
별도 CronJob이 없어도 Compose와 Kubernetes에서 같은 정책이 적용된다.

## 보존 작업

- 기본 보존 기간은 365일이며 관리자가 30~3,650일 또는 무기한으로 변경할 수 있다.
- worker는 한 transaction에서 현재 database 정책을 읽고 최대 1,000개를 오래된 순서로 정리한다.
- 여러 Core replica는 `FOR UPDATE SKIP LOCKED`로 같은 Event를 중복 처리하지 않는다.
- `project_history_promotions.audit_event_id`가 참조하는 Event는 만료되어도 삭제하지 않는다.
- 삭제가 발생하면 `background_job` actor의 `audit.retention_pruned` Event를 같은 transaction에 기록한다.
  이 Event 기록이 실패하면 삭제도 rollback한다.
- 무기한 정책에서는 정리 mutation과 결과 Event를 만들지 않는다.

정리 실패는 worker 실패로 처리되어 Supervisor와 운영 관측 경계에 전달된다. 관리자는 원인을 해결한 뒤
다음 worker 주기 또는 관리자 수동 prune으로 재시도할 수 있다. 개별 Event 삭제 API는 제공하지 않는다.

## 조회와 export

관리자 export는 JSONL과 CSV를 지원하며 한 페이지를 1,000개·20MiB로 제한한다. 큰 기간은 응답의 다음
cursor로 나누어 저장한다. CSV cell은 spreadsheet formula 실행을 막도록 중화한다. export 자체도
`audit.exported`로 기록되며 그 기록이 실패하면 파일을 성공 응답으로 반환하지 않는다.

export 파일은 운영자가 접근 제어·암호화·보존 정책을 가진 별도 목적지에 저장해야 한다. 제품은 외부 SIEM이나
장기 보관소로 자동 전송하지 않으며, OTLP application log를 Audit 원장 대체물로 취급하지 않는다.

## Backup과 무결성

온라인 backup의 PostgreSQL custom archive에는 `audit_events`와 이를 참조하는
`project_history_promotions`가 함께 포함된다. 복구 drill은 Event 내용뿐 아니라 foreign-key 참조가 동일하게
복원되는지 확인한다. live 보존 기간이 지난 Event도 이미 생성된 backup 안에서는 backup 보존 정책에 따라
남을 수 있으며, 개별 Event 제거를 위해 backup을 수정하지 않는다.

GA 검증은 실제 TLS PostgreSQL에서 자동·수동 prune과 rollback, JSONL/CSV export를 실행하고, 별도의
TLS PostgreSQL·HTTPS S3-compatible 저장소에서 암호화 backup 생성·검증·격리 복구를 수행한다.
