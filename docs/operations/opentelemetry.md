# OpenTelemetry OTLP export

OTLP export는 기본적으로 꺼져 있으며 Nuriteo가 운영하는 endpoint나 phone-home 경로는 없다. 운영자가
외부 Collector를 선택하고 trace, metric, log signal을 각각 `otlp`로 명시했을 때만 전송한다. 지원
protocol은 OTLP/gRPC와 OTLP/HTTP protobuf이다.

## 안전한 기본값

- endpoint는 signal이 하나라도 활성화되면 필수이며 `https`를 사용한다. 로컬 개발 fixture만 loopback
  `http`를 허용한다.
- 자동 endpoint fallback, TLS 검증 해제, 무제한 queue와 disk spool은 없다.
- 공통 queue는 기본 2,048개, 최대 4,096개이고 batch는 기본·최대 512개이다.
- export timeout은 기본 5초이고 100ms~10초만 허용한다. Collector 장애는 API·Save·backup 결과를
  실패시키지 않는다.
- trace head sampling 기본값은 10%이며 0~100% 범위만 허용한다.
- 종료 시 provider를 제한 시간 안에 flush한다. 남은 export 실패는 제품 데이터의 실패로 변환하지 않는다.

## 환경 설정

표준 OpenTelemetry 환경변수 `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`,
`OTEL_LOGS_EXPORTER`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`,
`OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_BSP_MAX_QUEUE_SIZE`,
`OTEL_BSP_MAX_EXPORT_BATCH_SIZE`, `OTEL_TRACES_SAMPLER_ARG`를 사용한다. signal exporter 값은 `none` 또는
`otlp`, protocol은 `grpc` 또는 `http/protobuf`만 허용한다.

Authorization header는 `NURITEO_OTLP_AUTHORIZATION_FILE`에 한 줄로 넣는 방식을 권장한다. 호환용 직접
환경변수 `NURITEO_OTLP_AUTHORIZATION`도 지원하지만 값은 log, Debug, metric, Support Bundle에 표시하지
않는다. 사용자 지정 CA는 `NURITEO_OTLP_CA_FILE`로 전달하며 system trust에 추가된다. CA가 잘못되면
startup이 실패하고 system trust로 자동 fallback하지 않는다.

Helm에서는 `observability.otlp` 아래에서 signal, endpoint, protocol, timeout, queue, sampling을 지정하고
Authorization은 기존 Kubernetes Secret reference로 전달한다. Docker Compose는 Collector를 번들로
설치하지 않으며 동일한 표준 환경변수를 외부 Collector에 연결한다.

## 데이터 경계

HTTP trace와 metric에는 method, 선언된 route template, status code/class만 사용한다. raw URL parameter,
query, request/response body, source, 사용자·Workspace·Project ID, Cookie, token, credential과 임의 오류 원문은
내보내지 않는다. OTLP log는 JSON/container logger와 동일한 고정 redaction visitor를 지난 뒤 전송한다.
Browser Runtime과 Preview에는 Collector endpoint나 credential을 전달하지 않는다.

정식 계약과 수치 경계는 `observability/otlp-policy.json`에 있으며, 장기 저장·검색·dashboard·alert와
Collector lifecycle은 운영자가 선택한 관측 backend의 책임이다.
