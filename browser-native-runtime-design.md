# Browser-Native Runtime 설계

작성일: 2026-09-15
상태: 초기 아키텍처 결정. 구현 및 호환성 검증 전.

## 1. 제품 목표와 결정

사용자가 기존 Node 프로젝트를 브라우저로 가져와 실제 npm 또는 pnpm으로 설치하고, 실행하고, 수정할 수 있는 안정적인 환경을 제공한다. 코드 실행은 브라우저에서 수행한다. Rust는 공통 시스템 기반을 구현하는 언어이며, Rust 사용량 자체보다 Node 호환성과 유지보수 가능성을 우선한다.

선택한 구조는 **호스트 브라우저 JS 엔진 + Node 호환 실행 계층 + Rust/WASM 시스템 계층**이다.

- 사용자 JS는 전용 Worker의 브라우저 JS 엔진에서 실행한다.
- TypeScript는 기존 변환기를 통해 JS로 변환해 같은 실행 계층에서 실행한다. 타입 검사는 별도 명령이다.
- Node의 JS 표준 라이브러리를 가능한 범위에서 재사용하고, 브라우저에 없는 내부 바인딩과 실행 기능을 어댑터로 제공한다.
- 실제 npm과 pnpm CLI를 실행한다. 자체 installer는 정식 지원을 대체하지 않는다.
- 동기 시스템 호출은 SharedArrayBuffer(SAB)와 Atomics 기반으로 연결한다.
- Rust가 파일과 프로세스 자원의 상태 및 접근 규칙을 소유한다. 브라우저 API 호출과 JS 객체 조작은 호스트/런타임 계층이 담당한다.
- Vivari의 접근과 공개 구현을 주요 참고 대상으로 삼되, 아직 포크 또는 전체 코드 도입을 확정하지 않는다.
- Node 실행이 우선이다. WASI 연결 가능성은 보존하지만 범용 Linux 호환 계층이나 다언어 제품을 먼저 만들지 않는다.

이 문서는 `browser-native-webcontainer-context.md`의 연구 내용을 바탕으로 내린 설계 결정을 기록한다. 기존 연구 문서는 보존한다. 실제 Node/npm/pnpm 지원을 이미 달성했다는 의미는 아니다.

## 2. 초기 지원선

| 항목 | 초기 목표 |
|---|---|
| 브라우저 | 데스크톱 Chromium, secure context, cross-origin isolation |
| Node | 한 LTS 계열의 고정 패치 버전 기준으로 호환 계약 관리 |
| 패키지 매니저 | 실제 npm 및 pnpm, 각각 고정 버전으로 시작 |
| 프로젝트 | Node CLI, 기본 HTTP 앱, npm/pnpm workspace, Vite 개발·빌드·HMR |
| 언어 | JS, TS; JSX/TSX는 선정한 변환기 지원 범위로 검증 |
| 파일 | 메모리 VFS, 프로세스 간 일관된 파일 상태, 명시적 저장·복원 |
| 프로세스 | 비동기 spawn, stdio, 종료 대기, 중단·재실행; 동기 spawn은 별도 통과 기준 |
| 네트워크 | 컨테이너 내부 가상 연결, HTTP preview, HMR, 정책에 따른 외부 요청 |

정확한 Node/npm/pnpm/Vite 버전은 첫 호환성 실험에서 조합을 확인한 뒤 manifest에 고정한다. `latest`로 시험 결과를 정의하지 않는다. 한 패키지 매니저부터 연결할 수 있지만 둘 모두 통과하기 전에는 초기 제품 완료로 판정하지 않는다.

초기 제외: SAB 없는 Lite, 모바일 및 Firefox/Safari 지원 약속, Yarn 지원 약속, 완전한 POSIX shell/TTY/signals, 일반 Linux 바이너리, 임의 native addon, 범용 raw 외부 TCP/UDP, Next.js 전반의 호환성, Python 등 추가 언어.

외부 프록시 없이 임의 registry/API에 접근할 수 있다고 약속하지 않는다. 네트워크 접근과 프로그램 실행 위치는 서로 다른 계약이다.

## 3. 전체 구조

```text
제품 UI / SDK 소비자
        |
Public SDK: boot / mount / spawn / stop / export / events
        |
Browser Supervisor
        |                               
        +-- Node Process Worker(s)
        |     Node JS library + bindings + module loader
        |     TS transform + runtime scheduling + user code
        |                  |
        |             syscall transport
        |                  |
        +-- System Worker: Rust/WASM core
        |     VFS / per-process FD / process state / pipes
        |     virtual connections / ports / capabilities
        |
        +-- Browser I/O adapters: Fetch / persistence
        |
        +-- Preview origin: Service Worker / iframe / HMR relay

후속 WASI Process Worker --> WASI adapter --> 같은 시스템 자원
```

위 배치는 우리의 초기 설계다. WebContainers의 비공개 Worker 토폴로지를 재현했다고 주장하지 않는다. 초기에는 한 System Worker가 커널과 VFS 상태를 소유한다. CPU 부하나 처리 지연 때문에 분리가 필요하면 측정 후 상태별 소유권을 유지하며 분리한다.

### 책임 경계

| 계층 | 소유하는 것 | 소유하지 않는 것 |
|---|---|---|
| Rust core | 파일/inode, open-file 상태, 프로세스별 FD, PID 상태, pipe/연결 버퍼, 권한, 계량 가능한 자원 한도 | JS 객체, Promise 큐, npm 의존성 규칙 |
| Node runtime | Node 객체와 오류 변환, 모듈 그래프/캐시, 타이머 및 실행 유지 상태, Node 바인딩 계약 | 별도의 원본 파일시스템, 브라우저 전역 접근 권한의 최종 강제 |
| Browser host | Worker 객체, MessagePort, 브라우저 I/O 수행, Rust 명령 실행과 결과 보고 | 독립적인 PID/파일/권한 원본 상태 |
| SDK | 사용자 명령과 스트림, 진단 및 이벤트 | Node 표준 라이브러리 내부 구현 |

Supervisor의 Worker 참조 목록은 실행 수단의 레지스트리다. 프로세스 상태의 기준은 Rust에 둔다. 생성은 prepare -> host create -> ready/failed 순으로 진행하며, 준비되지 않은 프로세스를 실행 중으로 노출하지 않는다.

Rust 코드도 모두 커널일 필요는 없다. 모듈 resolver, 변환기, 압축 라이브러리는 런타임이 사용하는 별도 도구로 둘 수 있다. Rust를 늘리기 위해 검증된 JS 코드를 다시 작성하지 않는다.

## 4. Node 호환 실행 계층

### Node 코드 재사용

고정 Node 버전의 JS 라이브러리와 필요한 내부 모듈을 추적 가능한 형태로 공급한다. 원본, 적용 패치, 출처·라이선스, 버전/해시를 분리 기록한다. 임의로 최신 Node 소스와 이전 바인딩을 혼합하지 않는다.

내부 바인딩은 안정적인 공개 ABI가 아니다. Node 버전별 어댑터를 통해 Rust의 언어 독립적 API로 변환한다. Node 내부 stat 배열이나 JS 객체 레이아웃을 커널 ABI에 넣지 않는다. process/child_process 등 직접 구현이 필요한 기능도 같은 버전의 테스트 대상에 포함한다.

crypto/압축/파서 등은 검증된 기존 JS/WASM 구현을 우선 검토한다. npm 다운로드를 지원하려고 암호 알고리즘이나 압축 포맷을 수작업으로 재구현하지 않는다.

### 모듈과 TypeScript

CJS와 ESM은 별도 의미 체계를 가진다. ESM을 CJS로 변환했다는 사실만으로 ESM 호환을 선언하지 않는다. resolver, 변환, linking/evaluation, 캐시를 구분한다.

필수 검증: package exports/imports 조건, package type, symlink/realpath, CJS 순환 참조, ESM live binding·순환 참조·top-level await, dynamic import, CJS/ESM 상호 운용, 모듈 단일 실행, 오류 위치와 소스맵.

기존 파서/변환기를 사용한다. 정확한 도구와 ESM 실행 전략은 초기 비교 실험으로 결정하며, 그 전에는 완전한 모듈 호환성을 약속하지 않는다. TS 실행과 타입 검사는 분리하고, 실제 `tsc` 실행은 Node 도구 호환성 테스트로 다룬다.

### 실행 흐름과 종료

호스트 Promise 동작을 활용하되 Node와 같은 실행 순서가 자동으로 성립한다고 가정하지 않는다. nextTick, Promise, timers, immediate, I/O 완료의 순서를 실제 Node와 비교한다.

프로세스 종료는 entry 함수 반환만으로 판단하지 않는다. 서버, 타이머, 자식 프로세스, Worker 등의 ref/unref 및 진행 중인 작업을 추적한다. `process.exit`와 자연 종료를 구분한다.

사용자 Worker가 동기 대기 중이어도 자식/스레드를 시작할 수 있어야 한다. Worker 생성은 독립적으로 진행 가능한 supervisor에 위임하고, 부모의 이벤트 콜백 실행을 필수 초기화 조건으로 만들지 않는다. 이 교착 방지 계약은 지원하는 WASM thread loader에도 적용한다.

## 5. Rust 자원 모델

### 파일시스템

컨테이너마다 하나의 원본 VFS를 둔다. 파일 이름과 inode를 분리하고 symlink와 hardlink를 서로 다른 기능으로 구현한다. hardlink를 symlink로 일반 치환하지 않는다.

FD 번호는 프로세스별이다. FD는 커널의 open-file 자원을 참조하며 파일 위치, open flags, 수명과 공유 규칙을 관리한다. Node와 WASI가 같은 FD 번호 공간을 전역 공유할 필요는 없다. 자식에는 지정된 핸들과 stdio를 명시적으로 연결한다.

필수 동작: open/read/write/close, stat/lstat/fstat, readdir, rename/unlink, symlink/readlink/realpath, link, truncate, 파일 변경 이벤트와 오류 코드. 열린 파일의 unlink, 짧은 읽기·쓰기, 종료 시 핸들 회수도 검증한다. 잠금 API는 실제 CLI 요구를 확인해 추가한다.

파일 변경은 원본 상태 반영 후 이벤트로 전달한다. 영속 저장은 실행 상태와 분리하고 flush 완료 시점을 명시한다. 저장 완료 전 탭 종료의 내구성을 약속하지 않는다. 동시 탭의 동일 저장 영역 쓰기는 초기에는 단일 writer로 제한한다.

### 프로세스와 자원 회수

상태: created -> starting -> running -> exiting -> exited 또는 failed. 논리 프로세스당 Worker 하나로 시작하지만 영구 커널 규칙으로 고정하지 않는다. worker_threads의 thread ID는 PID와 구분한다.

종료 시 FD, pipe 끝점, 포트, watch, pending I/O를 정리한다. SDK teardown은 소유 프로세스 전체를 정리한다. 일반 부모 종료와 컨테이너 teardown을 구분하고, 부모 종료 때 자식을 무조건 모두 죽이는 동작을 Node 호환이라고 가정하지 않는다.

프로세스 수, VFS 바이트, 전송 버퍼, 연결 수에는 강제 가능한 한도를 둔다. 브라우저 JS heap의 프로세스별 hard limit이나 정밀 CPU 선점은 제공한다고 주장하지 않는다. 응답 없는 사용자 Worker는 호스트에서 종료할 수 있게 한다.

## 6. 시스템 호출 프로토콜

동기 요청/응답과 비동기 요청/완료 이벤트를 분리한다. 네트워크 다운로드를 모두 동기 호출로 직렬화하지 않는다.

- ABI 버전, opcode, 요청 ID, 상태, 길이, 결과/오류를 정의한다.
- 동기 호출은 프로세스별 제한된 SAB를 사용하고 초기에는 채널당 한 요청만 허용한다.
- 클라이언트는 terminal 상태를 확인하는 루프로 대기한다. notify 자체를 완료 증거로 사용하지 않는다.
- 서버는 길이·범위·opcode와 핸들 소유권을 검증한다. PID는 요청 데이터만 믿지 않고 등록 채널에 연결한다.
- 큰 파일/응답은 chunk 또는 bounded stream으로 전달한다. 전체 데이터를 무제한 단일 프레임에 넣지 않는다.
- 비동기 완료, watch, stdio, 네트워크 이벤트는 별도 메시지 경로로 전달한다.
- 실행 세대 ID로 종료·재시작 후 늦은 응답을 구분한다.
- 취소는 이미 반영된 파일 변경을 자동 rollback하지 않는다. 실행 전 취소와 실행 후 결과 전달 취소를 구분한다.
- 커널은 사용자 Worker 응답을 동기적으로 기다리지 않는다. 시스템 처리 이벤트 루프를 막는 순환 대기를 금지한다.

고정 버퍼 크기와 복사 최적화는 측정 후 결정한다. 파일 캐시, 공유 읽기 snapshot, 여러 Worker에서 공유 커널 직접 호출은 초기 필수 기능이 아니다.

## 7. npm 및 pnpm

두 CLI를 별도 프로그램으로 VFS에 공급하고 동일한 Node 실행 계층에서 실행한다. CLI 원본·버전·integrity와 공급 경로를 기록한다. npm/pnpm의 lockfile, peer resolution, store 및 workspace 규칙을 자체 구현하지 않는다.

초기 fixture는 두 도구 각각에 대해 install, 재설치, lockfile 고정 설치, run/exec, workspace, 로컬 패키지 연결, lifecycle script, 캐시 재사용을 검증한다. CLI별 옵션과 정책 차이를 동일하게 만들려고 강제하지 않는다.

`.bin`, PATH, cwd, env, shell quoting, 종료 코드와 stdio는 첫 설치 후 실행 단계에 필요하다. 최소 shell은 실제 fixture가 요구하는 동작부터 구현하되, 조용히 잘못 해석하지 않고 미지원 구문을 명시한다.

native 빌드 도구를 무조건 성공하는 no-op로 대체하지 않는다. 지원하는 WASM 대체 경로가 있으면 사용하고, 없으면 해당 패키지/명령의 미지원 이유를 반환한다. optional dependency 처리는 패키지 매니저의 의미를 보존한다.

플랫폼/아키텍처 보고값은 설치 결과에 영향을 준다. 임의로 Linux 또는 wasm32라고 보고하지 않고, 선택한 CLI·패키지 및 WASM 대체물과 함께 검증해 호환 manifest에 명시한다.

## 8. 네트워크와 preview

세 경로를 분리한다.

1. 컨테이너 내부: 가상 포트와 연결, 읽기·쓰기·종료·backpressure.
2. Preview: 별도 오리진 Service Worker가 HTTP 요청을 실행 환경으로 전달.
3. 외부 요청: Fetch 기반 transport와 선택적 프록시.

Service Worker가 kernel의 원본 상태를 소유하지 않는다. 재시작과 실행 컨텍스트 소멸에 대응해 연결을 다시 맺고, 서버가 없으면 명확한 실패를 반환한다. client/container/port 및 요청 ID로 라우팅한다.

HMR WebSocket은 HTTP fetch 중계만으로 해결됐다고 보지 않는다. 별도 연결 어댑터와 close/error/재연결 계약을 검증한다. 요청·응답의 streaming, 취소, 중복 헤더 등은 지원 범위를 명세한다.

외부 Fetch가 Node HTTP의 모든 헤더·TLS·DNS 동작을 제공하지는 않는다. 공개 registry, private registry 인증, redirect, CORS를 각각 검증한다. 프록시를 쓰는 경우 인증·허용 목적지·자격증명 전달 정책을 명시하며 네트워크 일부가 서버를 경유함을 설명한다.

## 9. 격리와 배포

UI와 사용자 runtime, preview의 오리진 역할을 분리한다. 초기 runtime 실행 페이지에는 cross-origin isolation을 필수로 요구한다. COOP/COEP와 필요한 CSP/CORS/CORP를 배포 계약에 포함하고 실제 iframe/Worker 구성으로 확인한다.

Rust capability는 Rust를 경유하는 요청을 통제한다. 사용자 JS가 브라우저의 fetch/WebSocket/storage/Worker API에 직접 접근할 수 있으면 capability만으로 완전한 격리를 보장하지 못한다. 전역 함수 덮어쓰기를 보안 경계로 취급하지 않는다.

브라우저가 강제하는 CSP·오리진 제한과 커널 정책을 함께 검증한다. runtime 오리진에 제품 인증정보나 민감한 저장소를 두지 않는다. 임의 코드에 대한 강한 격리 보장은 별도 검증을 통과하기 전 제공하지 않는다.

## 10. WASM 및 다른 런타임

Node가 불러오는 WASM addon과 독립 WASI 프로그램을 구분한다. Emscripten/Node-API 계열 glue는 WASI만으로 대체할 수 없다. 필요한 기존 로더와 어댑터를 재사용한다.

Vite의 고정 의존성이 WASM 대체물을 요구하면 그 경로는 Vite 통과 전에 구현한다. 범용 WASI 도구 지원은 이후 단계로 둔다. 후속 WASI 어댑터는 같은 VFS와 자원 서비스에 연결하되 게스트별 FD 매핑을 가진다.

## 11. 유지보수와 도입 전략

참고 프로젝트의 README 지원 표만으로 제품 기반을 확정하지 않는다. Vivari 등을 고정 커밋으로 평가하고, 재사용 후보별 라이선스·출처·의존성·패치 부담을 확인한다. 기존 프로젝트 전체 포크와 부품 도입은 평가 후 결정한다.

원본 코드 변경은 작고 추적 가능하게 유지한다. upstream에 반영 가능한 개선은 우선 그 경로를 고려한다. 여러 프로젝트의 런타임 전체를 혼합하지 않는다. 부품별 소유 책임과 업데이트 경로를 정한다.

호환성 manifest에는 runtime build, Node 기준 버전, npm/pnpm 버전, 브라우저 버전, fixture 버전·lockfile hash, 어댑터 버전, 패치 목록을 기록한다.

API 상태는 verified/partial/unsupported/unverified로 기록한다. 테스트 하나 통과를 모듈 전체 호환으로 확대하지 않는다. stub은 성공으로 위장하지 않는다.

## 12. 검증과 개발 순서

| 단계 | 통과 조건 |
|---|---|
| D0: 기반 평가 | 참고 구현에서 같은 npm/pnpm fixture를 평가하고 수정량·제약 기록; Node 기준 버전과 재사용 범위 선정 |
| D1: 실행 경계 | JS Worker -> SAB -> Rust VFS 동기 호출, 오류, 큰 I/O, 대기 중 종료 및 재실행 |
| D2: Node 실행 | 모듈 로딩, 타이머/Promise/nextTick, ref/unref, 자식 실행, 자연 종료와 강제 종료 |
| D3: 패키지 매니저 | 실제 npm 및 pnpm의 install/workspace/scripts/exec/lockfile fixture 통과 |
| D4: 앱 실행 | HTTP preview, Vite dev/build/HMR, 파일 수정, 서버 stop/restart, 필요한 WASM 의존성 |
| D5: 안정화 | 반복 부팅·종료, 중단된 설치 복구, 저장·복원, 자원 잔류와 격리·배포 검증 |
| D6: 확장 | 다른 브라우저, 추가 Node 버전, WASI 도구, 다른 언어를 개별 목표로 평가 |

대조 가능한 동작은 동일 테스트를 실제 Node와 브라우저 runtime에서 실행한다. 정상 출력뿐 아니라 오류 코드, 종료 코드, 파일 결과, 모듈 관찰 동작을 비교한다. Node worker_threads 기반 테스트는 빠른 보조 수단이며 브라우저 검증을 대체하지 않는다.

성능은 install, cold/warm start, HMR, syscall 횟수·대기 시간, VFS/버퍼 사용량으로 측정한다. 초기 기준값을 확보한 뒤 회귀 허용치를 정한다. 수치 근거 없이 특정 구조가 더 빠르다고 확정하지 않는다.

초기 제품 완료는 D3~D5의 npm/pnpm 및 대표 앱 조건을 모두 충족해야 한다. 실패를 무시하는 fixture 수정으로 통과시키지 않는다.

## 13. 초기 코드 구성 제안

```text
crates/
  system-core/       VFS, handles, processes, pipes, capabilities
  system-wasm/       호스트 연결 및 protocol dispatch
packages/
  protocol/          ABI와 메시지 정의
  browser-host/      supervisor, I/O adapters, storage
  node-runtime/      Node loader, bindings, scheduling, transforms
  preview/           Service Worker 및 HMR 연결
  sdk/               public API
vendor/
  manifests/         원본 버전, hash, 출처, 라이선스
  patches/           버전별 변경
tests/
  contracts/         시스템 및 Node 동작 대조
  fixtures/          npm, pnpm, workspace, HTTP, Vite
  browser/           실제 브라우저 실행·격리·종료
```

초기에 세부 기능마다 crate를 만들지 않는다. 테스트와 의존성 경계가 실제로 필요할 때 분리한다. 이 문서는 저장소를 scaffold하라는 실행 지시가 아니다.

## 14. 남은 검증 결정

- 고정 Node/npm/pnpm/Vite 버전 조합 및 Node 코드 재사용 범위.
- Vivari 코드의 부품 도입/포크 여부와 출처 검토 결과.
- ESM 실행 전략과 TS 변환기.
- 실행 오리진 배치, Worker CSP, 외부 프록시 사용 범위.
- 설치 시 플랫폼 식별과 WASM package 선택 계약.
- 첫 ABI의 버퍼 크기, 저장소 flush/복원 형식.

이 항목은 미정 사실을 숨기기 위한 여백이 아니라 D0~D2에서 측정·검증할 작업이다. 전체 아키텍처 결정과 분리해 관리한다.

## 15. 근거와 참고 자료

공식 글은 작성 시점의 설명이다. 당시의 브라우저 제한이나 workaround를 현재 조건으로 그대로 복제하지 않는다. 비공개 제품의 내부 구현 언어·Worker 배치·Node loader는 공개 근거가 없는 한 추정으로 남긴다.

| 자료 | 설계에 반영한 내용 |
|---|---|
| [WebContainers 소개](https://blog.stackblitz.com/posts/introducing-webcontainers/) | 브라우저 실행, 가상 네트워크와 Service Worker 연결 |
| [Cross-Origin Isolation](https://blog.stackblitz.com/posts/cross-browser-with-coop-coep/) | SAB/Atomics 통신과 배포 조건 |
| [Sharp 포팅](https://blog.stackblitz.com/posts/bringing-sharp-to-wasm-and-webcontainers/) | WASM addon, Worker 시작과 동기 대기의 교착, ref/unref |
| [Safari 지원](https://blog.stackblitz.com/posts/webcontainers-are-now-supported-on-safari/) | 엔진 차이와 메모리 제약을 별도 검증 |
| [WASI 지원](https://blog.stackblitz.com/posts/announcing-wasi/) | 후속 도구·언어 확장 |
| [CORS Proxy](https://blog.stackblitz.com/posts/cors-proxy/) | 실행 위치와 외부 네트워크 경로 분리 |
| [공식 Troubleshooting](https://webcontainers.io/guides/troubleshooting) | Turbo 설치 경로와 native addon 제한; 실제 CLI 지원과 구분 |
| [Vivari 아키텍처](https://github.com/maitrungduc1410/vivari/blob/master/ARCHITECTURE.md) | Node JS 재사용, 바인딩, 실제 CLI, 시스템 호출 참고 |
| [OpenContainers](https://github.com/Welfordian/OpenContainers) | 호환성 상태와 fixture 기반 문서 관리 |
| [Nodepod](https://github.com/R1ck404/Nodepod) | SDK/headless 분리와 기능별 제한; 도입 조건 별도 검토 |
| [BrowserPod 구조](https://browserpod.io/blog/browserpod-deep-dive/) | Linux syscall 포팅 대안; 초기 범위에는 채택하지 않음 |

공통 원칙은 채택하되, 위 프로젝트의 모든 구현 선택이나 호환성 주장을 승인하는 것은 아니다. 우리의 지원 약속은 고정 버전과 재현 가능한 검증 결과로 정한다.
