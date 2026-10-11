# Runtime Lab test fixture

기능 테스트/Playwright harness 전용 UI입니다. 제품 미리보기 화면이 아닙니다.

- 제품 UI: `apps/web`
- 이 fixture는 `tests/system/browser/*`와 `__runtimeLab` smoke API에서만 사용합니다.

```sh
PORT=5173 node tests/fixtures/runtime-lab/server.ts
```
