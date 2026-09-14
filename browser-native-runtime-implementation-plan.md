# Browser-Native Runtime 구현 계획

작성일: 2026-09-15
기준: [설계 문서](./browser-native-runtime-design.md)
상태: 계획 수립 완료, 구현 미착수. 아래 파일과 명령은 앞으로 만들 산출물이다.

실제 작업은 [페이즈별 실행 가이드](./docs/implementation/README.md)와 [전체 진행표](./docs/implementation/PROGRESS.md)로 추적한다. 이 문서는 공통 기술 명세를 유지하며, 상태는 진행표에서만 관리한다.

## 1. 실행 원칙

목표는 실제 npm 및 pnpm으로 Node 프로젝트를 설치·실행하고 Vite 개발·빌드·HMR을 안정적으로 제공하는 것이다. 호스트 JS 엔진, Node 호환 계층, Rust/WASM 시스템 기반을 사용한다.

작업은 P0~P8 순서로 진행한다. 각 단계의 통과 증거를 남긴 뒤 다음 통합 단계로 이동한다. 개별 조사나 독립 모듈 구현은 병행할 수 있지만, 실패한 통합 조건을 완료로 표시하지 않는다.

중요한 변경: 기본 VFS를 모두 완성한 뒤 Node를 붙이지 않는다. 초기부터 작은 Node 실행 경로를 연결하며, 모듈 로딩과 실제 CLI의 장애를 먼저 발견한다. 커널을 크게 만든 뒤 Node 호환성이 불가능하다는 사실을 발견하는 순서를 피한다.

## 2. 단계 의존 관계

```text
P0 버전·기반 평가 + 실행 계약 결정
             |
P1 브라우저 부팅·오리진·테스트 하네스
             |
P2 작은 Rust VFS + SAB + Node fs 수직 연결
             |
P3 Node 모듈·비동기 동작·TS
             |
P4 프로세스·pipe·shell + 설치용 FS 보강
             |
P5 실제 npm·pnpm + 외부 HTTP transport
             |
P6 가상 네트워크·preview·WASM 의존성·Vite
             |
P7 저장·복구·반복 실행·격리 검증
             |
P8 버전 업데이트 연습 + 배포 패키지
```

P3의 Node 바인딩 조사와 P4의 Rust FS 보강은 P2 계약 확정 후 병행 가능하다. P5의 외부 transport와 P6의 내부 연결 모델은 인터페이스 정의 이후 독립 구현할 수 있다. 다른 언어와 Lite는 이 계획의 완료 조건에 포함하지 않는다.

## 3. P0: 구현 기준을 고정한다

### P0-1. 참고 구현의 재현성 평가

- Vivari를 첫 후보로 고정 커밋에서 조사한다. OpenContainers는 같은 항목의 비교 대상으로 사용한다.
- 평가용 checkout은 제품 소스와 분리한다. runtime을 제품에 자동 편입하지 않는다.
- 원본 런타임의 부팅, 실제 npm/pnpm 버전 출력, 작은 설치, 스크립트 실행, stop/restart를 기록한다.
- 실행 불가 항목도 missing/failed로 기록한다. 평가 단계에서 후보의 모든 버그를 수정하지 않는다.
- 보고서에 commit, 실행 명령, 브라우저, 로그, 수정 diff, 라이선스·출처, 의존성, 필요한 패치 목록을 남긴다.

산출물: `docs/evaluation/runtime-baseline.md`, `vendor/manifests/candidates.json`.

선정 기준: 실제 CLI 재현성 -> 수정해야 하는 호환 코드 범위 -> 버전 추적/출처 -> 브라우저 안정성 -> 성능. 기능 수나 README의 stable 표시는 선정 점수가 아니다.

### P0-2. 버전 및 도입 전략 결정

- 유지되는 Node LTS 한 계열 중 재사용 후보의 지원 기반과 맞는 정확한 패치 버전을 선택한다.
- 그 Node 버전에서 실행 가능한 npm/pnpm, Vite, TypeScript 버전을 선택한다.
- upstream Node 원본과 후보의 바인딩이 어떤 버전에 대응하는지 확인한다.
- 부품 도입을 기본 후보로 평가한다. 전체 포크가 수정량을 줄인다는 근거가 있으면 채택하되 Rust 커널 연결 범위를 별도로 기록한다.
- 선택한 패키지의 native/WASM 의존성과 platform/arch 조건을 목록화한다.

산출물: `compat/versions.json`, `docs/adr/001-runtime-source.md`, `docs/adr/002-platform-contract.md`.

버전 manifest 필수 필드: Node reference, CLI versions, Vite/TS, reference commit, browser revision, source integrity, patch set. 빈 값을 둔 상태로 P0를 통과시키지 않는다.

### P0-3. 모듈·변환·배포 가정 실험

- ESM 실행 후보를 같은 소형 fixture로 비교한다: live binding, 순환 참조, top-level await, dynamic import, CJS interop.
- 기존 변환기 후보의 브라우저/WASM 로딩, 동기 변환 가능 범위, sourcemap을 확인한다. 필요 시 부팅 시점에 비동기 초기화한다.
- runtime origin과 preview origin을 분리한 최소 페이지로 SAB 공유, Worker 시작, iframe handshake를 확인한다.
- JS 코드 생성 방식과 CSP가 충돌하는지 확인한다. 컴파일 편의를 위해 보안 보장을 과장하지 않는다.

산출물: `docs/adr/003-module-execution.md`, `docs/adr/004-origin-layout.md`.

**Gate G0:** 버전·출처·실행 전략이 고정되고 재현 명령이 있다. ESM 핵심 fixture가 성립하지 않으면 P3 전체 구현 전에 실행 전략을 재검토한다. 일정은 이 단계에서 측정한 수정량으로 산정한다.

## 4. P1: 부팅과 검증 기반

### 구현 파일

| 파일/디렉터리 | 책임 |
|---|---|
| `Cargo.toml`, `rust-toolchain.toml` | 두 Rust crate와 toolchain 고정 |
| `package.json`, workspace lockfile | SDK/host/runtime/protocol/preview 작업공간 |
| `packages/sdk/src/container.ts` | boot/teardown 상태 및 공개 진입점 |
| `packages/browser-host/src/supervisor.ts` | 실행 호스트 생명주기 |
| `packages/browser-host/src/workers/system-worker.ts` | Rust WASM 비동기 초기화와 ready |
| `packages/browser-host/src/workers/process-worker.ts` | trusted bootstrap; 이후 Node entry 실행 |
| `tests/harness/reference-node.*` | 별도 실제 Node에서 fixture 실행 |
| `tests/harness/browser.*` | Playwright에서 같은 fixture 실행 |
| `tests/harness/compare.*` | 출력·파일 결과·종료 비교 |
| `examples/runtime-lab/` | 작은 개발용 실행 화면; IDE 제작은 제외 |

### 작업

1. Rust native 테스트와 WASM 브라우저 로딩을 한 저장소에서 재현한다.
2. runtime/preview origin용 개발 서버 설정을 제공한다. 호스트 이름·포트는 설정 가능하게 한다.
3. SDK는 system ready 전 명령을 실행하지 않는다. 시작 실패 시 생성 자원을 정리한다.
4. fixture 결과 형식에 stdout/stderr bytes, exit code, filesystem assertions, event trace, runtime fingerprint를 포함한다.
5. 임의 sleep 대신 ready/exit/event를 기다리고 각 대기에는 상한을 둔다.

예정 명령: `cargo test --workspace`, `pnpm test:contracts`, `pnpm test:browser`, `pnpm dev:lab`.

**Gate G1:** 실제 Chromium에서 boot -> ready -> teardown 성공. 잘못된 격리 설정과 Worker 초기화 실패가 진단 가능한 오류로 끝난다. 사용자 코드는 메인 UI 스레드에서 실행되지 않는다.

## 5. P2: Rust VFS와 Node fs를 끝까지 연결

### 구현 파일

| 경로 | 책임 |
|---|---|
| `crates/system-core/src/{lib,error,ids}.rs` | 핵심 상태와 타입 |
| `crates/system-core/src/fs/{mod,inode,path,open_file,fd_table}.rs` | MemoryFS와 프로세스별 핸들 |
| `crates/system-wasm/src/{lib,dispatch}.rs` | WASM 경계와 요청 dispatch |
| `packages/protocol/schema.json` | opcode/field/error의 원본 정의 |
| `scripts/generate-protocol.*` | Rust/TS 상수와 wire 타입 생성 |
| `packages/protocol/src/{sync-client,async-client,codec}.ts` | transport 구현 |
| `packages/node-runtime/src/{bootstrap,builtin-loader}.ts` | 최소 Node library 초기화 |
| `packages/node-runtime/src/bindings/fs.ts` | Node fs binding -> kernel 호출 |

### 작업 순서

1. inode/경로/open-file/프로세스별 FD를 분리한다. 초기 bootstrap process ID만으로 시작한다.
2. open/read/write/close/mkdir/stat와 errno 변환을 구현한다.
3. wire schema에 ABI version, opcode, request ID, generation, length, status를 정의한다.
4. 동기 요청은 SAB에 payload를 쓴 뒤 atomic state를 전환하고 MessagePort로 알린다.
5. system worker는 nonblocking handler로 요청을 처리하고 결과 게시 후 notify한다.
6. 고정 Node의 `fs` 및 의존 built-in을 올려 아래 프로그램을 실행한다.

```js
const fs = require('node:fs');
fs.writeFileSync('/workspace/result.txt', 'hello');
console.log(fs.readFileSync('/workspace/result.txt', 'utf8'));
```

### 필수 검사

- 없는 파일, 잘못된 FD, directory/file 혼동, 열기 플래그, offset/짧은 읽기·쓰기.
- 데이터 프레임보다 큰 파일의 왕복과 바이너리 일치.
- 응답 게시가 wait보다 먼저 일어난 경우, 잘못된 요청 크기, 미지원 opcode.
- 대기 중 process 종료 후 새 process 실행; 이전 generation의 응답을 재사용하지 않음.
- system worker 자체 실패 시 SDK가 컨테이너 실패를 알리고 사용자 Worker를 정리함.

**Gate G2:** 브라우저에서 실제 Node fs 경로로 hello 출력. 위 장애 테스트 통과. 이 단계에서는 lodash, shell, 패키지 설치를 추가하지 않는다.

## 6. P3: Node 실행 정확도와 모듈

### 구현 파일

`packages/node-runtime/src/` 아래에 `node-profile.ts`, `internal-binding.ts`, `process.ts`, `scheduler.ts`, `liveness.ts`, `modules/{resolver,cjs,esm,cache}.ts`, `transforms/{typescript,sourcemap}.ts`를 둔다. 실제 채택 도구에 맞게 파일 경계는 조정한다.

### 작업 순서

1. P0에서 선정한 원본 Node 코드를 공급하는 스크립트와 integrity 검증을 만든다.
2. built-in import graph를 추적해 필요한 바인딩 목록을 생성한다. 없는 바인딩은 이름·호출 위치를 포함해 실패시킨다.
3. CJS 캐시 선등록/순환 참조, package type/exports/imports, realpath 규칙을 연결한다.
4. P0에서 선택한 ESM 전략을 적용하고 linking/evaluation 및 async module 상태를 분리한다.
5. timers/ref/unref, nextTick, host Promise yield, uncaught exception/rejection 및 종료 조건을 구현한다.
6. TS/JSX 변환과 원본 오류 위치를 연결한다. `tsc`는 이후 실제 패키지 fixture로 검사한다.
7. CLI 기동에 필요한 Buffer/events/stream/util/url 및 추가 built-in을 의존 순서대로 연결한다.

각 built-in 작업은 `원본 모듈 -> 필요한 바인딩 -> adapter -> reference test` 한 묶음으로 제출한다. 모든 내장 API를 선제적으로 작성하지 않는다.

**Gate G3:** `cjs-cycle`, `esm-live-binding`, `esm-cycle`, `esm-tla`, `dynamic-import`, `exports-conditions`, `ts-stacktrace`, `event-order`, `unref-exit` fixture 통과. npm/pnpm의 `--version` 경로를 이 단계부터 시도하고 추가 의존을 backlog에 기록한다.

## 7. P4: 프로세스·shell·설치용 파일 동작

### 구현 파일

- Rust: `process/{table,state,resources}.rs`, `io/{pipe,stdio}.rs`, `fs/{links,watch}.rs`.
- Host: `spawn.ts`, `worker-registry.ts`, `teardown.ts`.
- Node: `bindings/child-process.ts`, `worker-threads.ts`, `stdio.ts`.
- Shell: `packages/node-runtime/src/shell/` 또는 재사용 모듈. parser/runner와 지원 문법을 분리.

### 작업 순서

1. prepare -> Worker start -> ready/failed 상태 전환과 startup timeout을 구현한다.
2. 부모/자식 연결, cwd/env/PATH, stdio 배치, exit/wait 이벤트를 연결한다.
3. bounded pipe와 backpressure, EOF, broken pipe, 읽지 않는 소비자 종료를 처리한다.
4. `spawn`, `execFile`, `spawnSync`/`execSync`의 필요한 범위를 구현한다. 동기 부모 대기 중에도 supervisor는 계속 진행한다.
5. Worker thread ID와 process ID를 분리하고 parent-blocked startup 및 ref/unref를 검증한다.
6. symlink/lstat/readlink/realpath, hardlink/nlink, rename, truncate, watch, permission metadata 중 fixture 요구를 연결한다.
7. `.bin`/shebang과 최소 `sh -c`를 지원한다. quoting, env, `&&`, pipe, redirect를 명시된 범위에서 테스트한다.

**Gate G4:** 두 프로세스의 공유 파일 관찰, 열린 파일 unlink, 부모/자식 stdio, 동기 자식 실행, pipeline 및 종료 후 FD 회수 통과. 모든 sync bridge 대기에는 외부 watchdog 테스트가 있어야 한다.

## 8. P5: 실제 npm·pnpm 설치

### 구현 파일

- `scripts/vendor-cli.*`, `vendor/manifests/{npm,pnpm}.json`: 고정 CLI 공급; 호환 코드 아님.
- `packages/browser-host/src/io/{fetcher,fetch-policy}.ts`: 실제 네트워크 I/O.
- `packages/node-runtime/src/bindings/{http-client,https-client,crypto,zlib}.ts`: CLI가 요구하는 동작 연결.
- `tests/fixtures/package-managers/{npm,pnpm}/`: 각 CLI fixture와 lockfile.
- `compat/node-bindings.json`: 호출·지원·대조 테스트 연결.

### 작업 순서

1. 부팅 bootstrap용 CLI asset을 비동기로 공급하고 integrity 확인 후 VFS에 배치한다. 자체 dependency resolver는 만들지 않는다.
2. HTTP transport에 병렬 요청, bounded download, 취소, redirect, 오류와 헤더 처리를 연결한다.
3. 압축/해시 구현을 재사용하고 streaming 및 큰 tarball을 검증한다.
4. npm의 최소 설치를 통과시킨 뒤 pnpm 최소 설치를 통과시킨다. 이어서 아래 매트릭스를 두 CLI 모두 수행한다.
5. 누락 API는 CLI 호출 trace로 좁혀서 수정한다. 패키지 이름별 무조건 성공 분기는 금지한다.

| Fixture | 실제 Node와 비교할 결과 |
|---|---|
| `install-basic` | 설치 패키지 실행, 예상 dependency versions |
| `locked-install` | npm ci / pnpm frozen lockfile 실행, lockfile 변경 없음 |
| `workspace-local` | 각 도구의 workspace 규칙, 로컬 수정 반영, .bin 실행 |
| `lifecycle` | 선택 버전의 승인 정책에 맞춘 스크립트 실행/거부, 출력/종료 코드 |
| `peer-optional` | peer 관계, optional 실패 동작, platform 분기 |
| `cache-repeat` | 동일 artifact 반복 설치와 다운로드 감소 |
| `registry-errors` | 401/404/잘못된 integrity/redirect 오류가 명확하게 전파 |
| `interrupted-install` | 중단 후 재실행 결과가 정상 설치와 동일한 의미를 가짐 |

두 CLI의 lockfile이나 폴더 배치를 서로 동일하게 비교하지 않는다. 각 CLI와 동일한 실제 Node 실행을 기준으로 비교한다. timestamp·절대 경로 등 비결정 값만 사전에 정의한 규칙으로 정규화한다.

공개 네트워크 테스트와 통제된 registry fixture 테스트를 분리한다. private registry 인증은 인증정보를 로그에 남기지 않고 교차 오리진 redirect 전달 정책을 검사한다.

**Gate G5:** 두 CLI의 install/run/exec/workspace 및 lockfile fixture 통과. native build 불가를 설치 성공으로 숨기지 않음. 실제 CLI 바이너리/entry와 버전이 결과에 기록됨.

## 9. P6: HTTP·preview·WASM·Vite

### 구현 파일

- Rust: `net/{port_table,connection,buffer}.rs`.
- Node: `bindings/{tcp,http-parser}.ts`, `websocket-bridge.ts`, `wasm-adapters/`.
- Preview: `service-worker.ts`, `relay.ts`, `session.ts`, `hmr-client.ts`.
- Fixture: `http-stream`, `vite-vanilla`, `vite-ts`, `vite-workspace`, `wasm-required`.

### 작업 순서

1. 내부 연결의 listen/connect/read/write/close와 port 충돌을 구현한다.
2. 고정 Node HTTP 코드와 parser를 연결하고, request/response streaming 및 client 취소를 검증한다.
3. preview bootstrap handshake에서 origin/source/session을 검증하고 MessagePort를 연결한다.
4. Service Worker 요청을 container/port/request ID로 전달한다. timeout과 서버 부재는 명확한 HTTP 실패로 반환한다.
5. HMR의 WebSocket 경로를 별도 구현한다. 일반 fetch 이벤트가 WebSocket을 자동 처리한다고 가정하지 않는다.
6. P0의 의존 목록에 따라 Vite가 필요로 하는 WASM loader 및 Node-API/WASI/thread 어댑터만 먼저 연결한다.
7. npm과 pnpm 각각으로 Vite 설치 -> dev -> preview -> 코드 수정 -> HMR -> build -> stop/restart를 실행한다.

**Gate G6:** preview 텍스트 변경뿐 아니라 HMR 상태 보존 fixture 통과. 서버 종료 후 포트 재사용, SW 재시작 후 재연결, 큰 응답, 중간 취소 통과. build 산출물도 실제 브라우저에서 실행된다.

## 10. P7: 저장·복구·자원·격리

파일: `packages/browser-host/src/storage/{snapshot,opfs,lease}.ts`, Rust `snapshot.rs`, `limits.rs`, `tests/browser/{recovery,isolation,soak}.test.ts`.

1. snapshot에 형식 버전, inode/link 관계, 내용 integrity를 포함한다. 임시 세대를 쓴 뒤 완료 marker로 publish한다.
2. 단일 writer lease를 확보하고 같은 저장 공간의 두 번째 writer를 명시적으로 거부한다.
3. `flush()` 완료를 명시하고 미완료 세대에서 이전 완료 snapshot으로 복구한다. corrupt 데이터는 조용히 로딩하지 않는다.
4. SDK teardown을 반복 호출해도 안전하게 만들고, 생성 실패와 대기 중 종료의 자원 회수를 검사한다.
5. 직접 fetch/WebSocket, 중첩 Worker, origin 저장소 접근 등 capability 우회 경로를 실제 CSP와 함께 시험한다.
6. boot/spawn/stop/teardown 100회 반복을 초기 soak 기준으로 사용한다. timeout은 환경별 manifest에 고정한다.
7. 각 회차 종료 후 process/FD/watch/port/pending-request 수가 기준값으로 돌아오는지 확인한다. JS heap 측정 가능 범위는 별도 보고하고 정밀 hard limit을 주장하지 않는다.

**Gate G7:** 저장 중단·설치 중단·Worker 실패에서 복구 가능. 논리 자원 누적 없음. 외부 통신과 격리의 실제 보장 범위가 문서와 일치.

## 11. P8: 유지보수 리허설과 배포

1. 고정 Node에서 다음 사용 가능한 패치 버전으로 원본을 교체하는 연습을 한다. 수정 파일 수, binding 변경, 실패 fixture를 기록한다.
2. npm/pnpm은 한 번에 하나씩 업데이트해 변경 원인을 분리한다.
3. 신규 patch마다 원인·upstream 링크·재현 테스트를 연결한다. 기준 fixture를 약화해서 업데이트를 통과시키지 않는다.
4. clean install에서 SDK/Worker/WASM asset을 빌드하고 독립 소비자 예제로 로딩한다.
5. base path, asset MIME, worker URL, CSP/COOP/COEP, preview origin 배포 설정을 검증한다.
6. 지원 매트릭스와 알려진 제약, 버전 fingerprints를 release artifact에 포함한다.

**Gate G8:** Node 업데이트 비용 보고서와 재현 가능한 SDK 배포 예제가 있다. 외부 서비스 공개 배포 및 패키지 publish는 이 구현 계획과 별도의 실행 요청으로 다룬다.

## 12. PR 크기와 첫 작업 묶음

한 PR은 하나의 관찰 가능한 동작과 그 검증을 포함한다. 기존 Node 코드 대량 import는 adapter 수정과 분리한다. 아래 순서가 초기 backlog다.

| 순서 | 작업 | 완료 증거 |
|---|---|---|
| 1 | 참고 구현 pin 및 실행 기록 | candidate report, 출처와 실패 목록 |
| 2 | Node/CLI/Vite 버전·도입 ADR | versions manifest, 선택 근거 |
| 3 | 모듈/오리진 소형 실험 | ESM 및 SAB fixture 결과 |
| 4 | workspace·브라우저 하네스 | clean checkout 부팅 |
| 5 | wire schema와 Rust/TS 생성 | golden frame 상호 해석 |
| 6 | 최소 MemoryFS/FD | Rust 동작 테스트 |
| 7 | Worker SAB roundtrip | 브라우저 오류·종료 검사 |
| 8 | Node bootstrap와 fs binding | 실제 fs-sync 프로그램 실행 |
| 9 | 모듈·스케줄링 계약 | reference Node 비교 |
| 10 | 자식 프로세스·pipe·FS links | workspace 실행 기반 |

시간 견적은 P0 결과 이전에 달력 단위로 약속하지 않는다. 주된 불확실성은 ESM/비동기 의미 보존, Node 내부 바인딩 범위, WASM thread 초기화다. 각 항목은 실패 증거를 확보하면 실행 전략을 재검토하며, 임시 stub을 정식 지원으로 승격하지 않는다.

## 13. 검증 명령 계약

아래 명령은 구현 과정에서 제공할 인터페이스이며 현재 존재하지 않는다.

| 명령 | 목적 |
|---|---|
| `cargo test --workspace` | Rust 자원 모델·오류·FS 계약 |
| `pnpm test:protocol` | 생성 코드 일치, golden bytes, 잘못된 frame |
| `pnpm test:contracts` | reference Node와 실행 동작 대조 |
| `pnpm test:browser` | 실제 Chromium의 Worker/격리/preview |
| `pnpm test:pm -- --manager npm` | 실제 npm fixture |
| `pnpm test:pm -- --manager pnpm` | 실제 pnpm fixture |
| `pnpm test:apps` | HTTP·Vite 개발/빌드/HMR |
| `pnpm test:soak` | 반복 종료·복구·자원 회수 |
| `pnpm verify` | 현재 도달 단계까지 필수 검증 집계 |

모든 CI 작업은 timeout과 로그 artifact를 갖는다. 일반 PR에서는 통제 fixture를 사용하고, 외부 registry smoke는 분리한다. skip/unsupported/unverified는 pass와 구분한다.

## 14. 초기 제품 완료 정의

- 정확한 버전과 출처가 기록된 Node 실행 환경이다.
- 실제 npm과 pnpm이 각각 설치·workspace·scripts·exec·lockfile 검사를 통과한다.
- JS/TS 및 명세된 CJS/ESM 동작이 실제 Node 대조 검사를 통과한다.
- Vite dev/build/HMR과 필수 WASM 의존성이 동작한다.
- 동기 대기·자식 실행·종료·재시작에서 교착과 논리 자원 잔류가 없다.
- 저장 완료와 복구 의미가 분명하고 실제 배포의 격리 조건이 검증됐다.
- Node 업데이트 리허설 결과와 알려진 제약을 공개할 수 있다.

현재 완료된 것은 설계와 구현 계획 문서다. 코드 구현, 참고 프로젝트 실행 평가, 테스트 통과는 아직 수행하지 않았다.
