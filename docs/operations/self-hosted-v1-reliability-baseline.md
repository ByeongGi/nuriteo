# Self-hosted v1 성능·자원·신뢰성 기준선

측정일: 2026-10-12  
정본: `compat/self-hosted-v1-reliability-baseline.json`

GA는 최대 처리량 숫자만 약속하지 않는다. 사용자가 반복 실행해도 자원이 원상 복귀하고, 외부 collector가
고장 나도 서비스 종료가 멈추지 않으며, 정해진 자원 한도를 넘으면 부분 기록 없이 실패하는지를 필수
기준으로 삼는다.

| ID | 실제 결과 | 통과 기준 |
|---|---|---|
| `browser-runtime-soak` | Chrome에서 1,000회 boot/run/teardown PASS | 매회 worker·pending request·file·watch·port가 0으로 복귀 |
| `browser-worker-resource-churn` | 30회 성공, 강제 실패/복구 3회, worker target 0→0 | target 누수 없음, 모든 복구 성공 |
| `browser-watchdog-recovery` | actual Chrome recovery PASS | 256 MiB admission 거부, timeout teardown, clean reboot |
| `large-node-modules` | 2,500 files, cache eviction·atomic ENOMEM PASS | Project 보존, 용량 회수, 부분 write 없음 |
| `offline-workflow` | install/dev/Preview/export/Yarn PASS | network 없이 반복 Preview 응답 |
| `otlp-outage-and-shutdown` | 5 focused tests PASS | queue/batch bound, redaction, flush, outage timeout |
| `production-server-lifecycle` | TLS PostgreSQL + HTTPS S3 PASS | startup/readiness/drain/shutdown, backend 불변 |

## 자원 계약

- workspace admission과 실제 in-memory file storage는 각각 256 MiB 한도다.
- product Worker가 만드는 WebAssembly memory는 최대 32,768 page(2 GiB address space)다. 이는 workspace
  256 MiB 한도와 다른 계약이다.
- 브라우저 API는 Worker별 JavaScript heap hard cap을 제공하지 않으므로 그런 보장을 주장하지 않는다.
- page/agent-cluster memory 관측치는 GC와 브라우저 accounting 영향을 받으므로 leak hard threshold로 쓰지
  않는다. 대신 worker target과 제품이 소유한 resource count의 baseline 복귀를 release gate로 사용한다.

필수 결과 실패, teardown 후 resource 잔존, collector outage shutdown timeout 초과, 새 측정 없이 자원 한도
완화 중 하나라도 발생하면 release를 차단한다.
