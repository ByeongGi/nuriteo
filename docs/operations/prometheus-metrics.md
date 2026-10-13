# Prometheus metrics

Nuriteo Core는 cluster-internal HTTP service의 `/metrics`에서 OpenMetrics 1.0을 제공한다. Docker Compose는
Core port를 host에 publish하지 않고, Helm은 Core를 ClusterIP로만 노출하므로 public Web ingress를 통해
접근할 수 없다. 외부 scrape가 필요하면 운영자가 이 내부 service에 명시적으로 접근 권한을 부여한다.

공식 metric 목록과 호환성 계약은 `observability/metric-catalog.json`에 있다. HTTP metric의 `route`는
실제 URL이 아니라 선언된 route template이다. 사용자·조직·프로젝트 ID, query, request/trace ID, email과
오류 원문은 label로 내보내지 않는다. 알 수 없는 route와 method는 각각 `unmatched`, `OTHER`로 합친다.

초기 GA catalog는 process와 HTTP golden signals에 한정한다. DB pool, S3, background queue,
backup/restore와 OTLP exporter metric은 각 subsystem에 실제 계측 지점을 추가할 때 additive metric으로
확장하며, 임의 사용자 값을 label로 추가하지 않는다.
