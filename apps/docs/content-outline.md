# NURITEO 문서 사이트 콘텐츠 구성

`apps/docs`는 NURITEO와 `@nuriteo/sdk`의 공개 문서 SPA다. React Router로 주소를 나누고, 색·글꼴·테마는 `apps/web`의 한지·청화 토큰과 Pretendard를 따른다.

이 문서는 페이지에 실을 내용의 목차다. 루트 `docs/`의 보안 대응 문서, 장애 플레이북, 알려진 제한은 릴리스 검사가 읽는 경로이므로 옮기지 않는다. 사이트는 그 내용을 공개 문장으로 다시 쓰고 원본 경로를 링크한다.

공개하지 않는 것: 비공개 기획 저장소의 구현 태스크, 게이트 증거, 릴리스 판정 JSON, 내부 운영 리허설.

언어: 제품 화면은 한국어, 저장소 안내는 영어와 한국어가 짝이다. 사이트도 같은 페이지를 한국어와 영어로 둔다. 아래 제목은 한국어 주소의 이름이다.

## 누가 읽는가

| 독자 | 필요한 문서 |
|---|---|
| 인스턴스를 설치하는 운영자 | 설치, 첫 관리자, 업그레이드, 보안 |
| 브라우저에서 프로젝트를 여는 사용자 | 사용, 미리보기, 지원 범위 |
| 페이지에 런타임을 붙이는 개발자 | SDK |
| 이 저장소를 고치는 기여자 | 개발 |

## 주소

```text
/                         소개
/install                  설치 개요
/install/source           소스에서 실행
/install/compose          단일 호스트 Compose
/install/kubernetes       Helm
/install/admin            첫 관리자
/install/upgrade          업그레이드
/use                      사용 개요
/use/projects             프로젝트 열기와 편집
/use/preview              미리보기
/use/files                파일과 터미널
/limits                   지원 범위
/sdk                      SDK 개요와 브라우저에서 실행되는 예시
/sdk/install              설치
/sdk/container            런타임 컨테이너
/sdk/filesystem           파일
/sdk/packages             패키지
/sdk/processes            프로세스
/sdk/preview              미리보기와 워커
/sdk/projects             프로젝트 묶음
/sdk/webcontainer         WebContainer형 입구
/sdk/adapters             어댑터
/security                 보안
/develop                  개발 개요
/develop/repository       저장소 지도
/develop/local            로컬 개발
/develop/checks           검사와 테스트
/develop/sdk-release      SDK 빌드와 배포
```

영어 주소는 같고, 본문만 영어다. 언어 전환은 같은 경로를 유지한다.

## 소개

`/`

NURITEO는 브라우저에서 프로젝트를 열고, 설치하고, 고치고, 실행하고, 미리보기로 결과를 보는 오픈 소스 개발 환경이다. 이 저장소의 제품은 셀프호스트다. 매니지드 클라우드, 라이선스 키, 전화 홈 활성화는 없다. 라이선스는 Apache-2.0이다.

첫 화면은 세 갈래만 둔다.

- 인스턴스 설치
- 브라우저에서 사용
- `@nuriteo/sdk`로 런타임 붙이기

지원되는 하루 경과는 데스크톱 Chrome에서 Vite 프로젝트를 열고, 선언된 패키지를 설치하고, 편집하고, 미리보기가 갱신되는 것이다.

## 설치

운영자가 자기 인프라에 Core와 Web을 올리는 문서다. 세 설치 방식은 목적만 다르게 안내하고, 첫 관리자 만들기는 한 페이지로 모은다.

### 설치 개요 `/install`

공통 구성: Web, Core, PostgreSQL, 객체 저장소(RustFS 또는 S3 호환). 브라우저에 열리는 것은 Web뿐이다. 저장과 미리보기 트래픽은 애플리케이션 출처를 벗어나지 않는다.

선택 기준:

- 소스를 고치며 실행: `/install/source`
- 한 대에 제품과 같은 경계로 실행: `/install/compose`
- Kubernetes: `/install/kubernetes`

요구 버전은 소스 실행에만 해당한다. Node.js 24.17 이상 25 미만, pnpm 11.15 이상 12 미만, Rust 1.97.

### 소스에서 실행 `/install/source`

저장소를 클론한 뒤 `pnpm install`, `pnpm dev`. PostgreSQL과 RustFS는 컨테이너로 남고, Core는 Rust 변경 때 다시 빌드되며, Web은 `http://127.0.0.1:3000`에서 Next.js HMR로 갱신된다.

같이 적을 명령:

- `pnpm dev:backend`, `pnpm dev:web` (`pnpm dev:fe`는 Web과 같다)
- `pnpm dev:stack`, `dev:stack:status`, `dev:stack:credentials`, `dev:stack:down`, `dev:stack:reset`
- 개발 자격과 TLS는 `.local/nuriteo-compose`에 생긴다. 이 값은 로컬 전용이다.

이 경로는 기여자와 소스를 직접 실행하는 운영자를 위한 것이다. 이미지로 올리는 절차는 Compose와 Helm에 둔다.

### Compose `/install/compose`

공식 단일 호스트 구성이다. Web만 호스트 포트를 연다. Core, PostgreSQL, RustFS는 Compose DNS와 내부 네트워크를 쓴다. 묶인 RustFS는 브라우저에 노출되지 않는다.

시작 순서는 저장소 준비, 마이그레이션, 첫 관리자 생성, 그다음 Core와 Web이다. 자격 증명 기본값은 없다. 비밀번호, TLS, 미리보기 서명 키, 통합 자격 마스터 키는 파일이고 값 자체는 문서에 예시로 넣지 않는다. 변수 이름과 파일이 필요한 이유만 적는다.

데이터는 `compose down` 뒤에도 볼륨에 남는다. 볼륨 삭제는 데이터를 지울 때만 한다.

외부 S3를 쓰는 구성은 별도 절로 둔다. 브라우저가 버킷에 직접 붙지 않으므로, 묶인 버킷의 CORS 정리와 외부 버킷의 CORS 계약을 섞어 쓰지 않는다.

업그레이드 명령의 존재는 `/install/upgrade`로 보낸다.

### Kubernetes `/install/kubernetes`

차트는 `deploy/charts/nuriteo`다. Kubernetes 1.29 이상. PostgreSQL은 차트 밖에 둔다. 운영 저장소는 외부 HTTPS S3 호환 저장소다. Web과 Core는 한 릴리스이고 이미지 다이제스트로만 고정한다. 시크릿 값은 Helm 값이 아니다. 이미 있는 Secret의 이름과 키를 참조한다.

차트는 배포 전에 사전 검사, 마이그레이션, 첫 관리자 작업을 순서대로 돌리고, 그다음 Web과 Core를 만든다. 실패한 훅은 이전 릴리스를 남겨 둔다.

### 첫 관리자 `/install/admin`

설치가 끝나면 인스턴스 관리자 한 명이 필요하다. Compose와 Helm 모두 bootstrap으로 이메일, 표시 이름, 비밀번호 파일을 받는다. 부트스트랩이 끝나면 그 계정으로 서명하고, 이후 사용자는 관리자 초대로 들어온다. 공개 가입 페이지는 없다.

비밀번호는 URL에 실리지 않는다. 서명 폼은 POST다.

### 업그레이드 `/install/upgrade`

데이터베이스 변경은 앞으로만 간다. 롤백은 Core와 Web 이미지를 이전으로 되돌리는 절차이고, 스키마를 다운그레이드하지 않는다. 스키마나 객체를 되돌려야 하면 복원이다.

SDK 배포 채널을 되돌리는 것과 인스턴스 데이터베이스를 되돌리는 것은 다른 일이다. 채널 포인터만 바뀌고, 이미 설치된 데이터베이스는 다시 쓰이지 않는다.

## 사용

데스크톱 Chrome에서 서명 이후의 하루 경과도다.

### 사용 개요 `/use`

서명 뒤 워크스페이스에서 프로젝트를 연다. 되는 경로는 Vite 프로젝트를 열고, 그 프로젝트가 선언한 패키지를 설치하고, 파일을 고치고, 미리보기가 따라오는 것이다.

### 프로젝트 `/use/projects`

프로젝트를 만들거나 연다. 템플릿 또는 가져온 묶음에서 시작할 수 있다. 편집기는 저장한 내용이 프로젝트 파일로 남는다. 패키지 설치는 프로젝트에 선언된 의존성을 대상으로 한다.

### 미리보기 `/use/preview`

미리보기는 별도 출처에서 열린다. 설치와 편집이 반영되면 미리보기가 갱신된다. 미리보기 도메인은 설치 때 정한 와일드카드 도메인이다. 사용 문서는 그 도메인이 왜 애플리케이션 도메인과 나뉘는지까지만 설명한다.

### 파일과 터미널 `/use/files`

파일 트리에서 읽고 쓴다. 프로젝트 터미널에서 선언된 패키지 매니저 명령을 실행한다. 임의 셸 제품 전체를 약속하지 않는다. 지원 범위 페이지로 한계를 보낸다.

관리자 화면(초대, 백업, 감사 로그, 레지스트리, 신원 공급자)은 이 사용 묶음에 짧은 절만 두고, 운영 절차는 설치와 보안 문서로 보낸다. 관리자 기능 전체를 사용자 가이드로 풀어 쓰지 않는다.

## 지원 범위 `/limits`

지원하는 것:

- 셀프호스트 Core
- 데스크톱 Chrome
- Vite 프로젝트를 열고, 선언된 패키지를 설치하고, 편집하고, 미리보기

범위 밖:

- 매니지드 클라우드
- 임의의 npm 패키지 전체
- 모바일 Safari
- 브라우저 안의 Docker
- 네이티브 애드온

이 페이지는 루트 `docs/release/known-limitations.md`와 같은 범위를 사용자 문장으로 다시 쓴 것이다.

## SDK

`@nuriteo/sdk`는 브라우저 페이지 안에 NURITEO 런타임을 붙이는 라이브러리다. 셀프호스트 서버가 아니다. 파일, 패키지, 미리보기, 프로젝트 동작은 호출하는 쪽이 어댑터를 연결한다. 패키지는 그 입구와 브라우저 런타임 자산을 담는다.

### 개요와 실행 예시 `/sdk`

문서 사이트의 `/sdk`는 설명만 두지 않고, 그 페이지 안에서 `@nuriteo/sdk`의 `createContainer()`로 시스템 워커와 프로세스 워커를 부팅한다. 예시는 `entrypoint: "fs-smoke"`로 워크스페이스 파일에 `hello`를 쓰고 다시 읽어 화면에 프로토콜 버전, 상태, 읽은 값, 크기를 보여 준다. 동적 JavaScript 평가는 런타임이 막으므로, 예시 소스를 방문자 입력으로 실행하지 않는다.

페이지를 열 때는 Cross-Origin Isolation이 필요하다. 개발 서버는 `Cross-Origin-Embedder-Policy: require-corp`와 `Cross-Origin-Opener-Policy: same-origin`을 붙인다. 워커와 WASM은 `apps/web`의 런타임 자산 빌드를 `apps/docs/public/runtime`에 만들어 같은 출처로 제공한다.

### 개요에서 설명할 기능

제공하는 것:

- 런타임 부팅, JavaScript 실행, 상태와 메트릭, 종료
- 파일 읽기·쓰기·디렉터리·삭제·변경 감지
- npm, pnpm, Yarn으로 설치하고 스크립트와 바이너리 실행
- 작업 디렉터리와 환경 변수를 지정한 프로세스 실행
- 미리보기 포트, 서비스 워커, 워커와 WASM 주소
- 프로젝트 묶음 내보내기와 가져오기
- `createNuriteoWebContainer()`로 묶은 WebContainer형 입구
- 파일·패키지·미리보기·프로세스 호출의 시작, 성공, 실패 추적

패키지에 들어 있는 실행 자산: `system_wasm.wasm`, 시스템 워커, 프로세스 워커, Next·Vite·Yarn 실행 파일.

### 설치 `/sdk/install`

```sh
npm install @nuriteo/sdk@beta
```

공개 버전은 `0.1.0-beta.1`이고 `beta` 태그가 그 버전을 가리킨다. `latest`는 이름만 등록한 `0.0.0`이므로 태그 없이 설치하지 않는다.

패키지는 ESM과 CommonJS, 타입 선언을 낸다. `repository`는 `github.com/ByeongGi/nuriteo`다. 배포에는 npm 배포 증명과 SLSA provenance가 붙는다. 증명은 빌드 출처이지 동작 보장이 아니다.

### 런타임 컨테이너 `/sdk/container`

`createContainer()`와 `Nuriteo`. `boot`, `run`, `teardown`, `status`, `metrics`, `systemMetrics`. 서비스 모음은 `services`에 있다.

### 파일 `/sdk/filesystem`

`services.fs`. 읽기, 쓰기, 디렉터리 나열, 만들기, 삭제, 감시.

### 패키지 `/sdk/packages`

`services.packages`. 선언된 패키지 설치와 스크립트·바이너리 실행. 매니저는 npm, pnpm, Yarn.

### 프로세스 `/sdk/processes`

`services.processes`. 작업 디렉터리, 환경 변수, 실행 핸들.

### 미리보기와 워커 `/sdk/preview`

`services.preview`. 열린 포트와 미리보기 이벤트. `resolveNuriteoWorkerAssets()`는 시스템 워커, 프로세스 워커, `assets/system_wasm.wasm` 주소를 계산한다. `registerNuriteoPreviewServiceWorker()`는 미리보기 서비스 워커를 등록한다. 서비스 워커가 없는 환경에서는 `SdkError`다.

### 프로젝트 묶음 `/sdk/projects`

`services.projects`. 묶음 내보내기와 가져오기.

### WebContainer형 입구 `/sdk/webcontainer`

`createNuriteoWebContainer()`, `createNuriteoMountSnapshot()`. 부팅, 작업 디렉터리, 파일, 명령, `port` · `server-ready` · `server-close` 이벤트. COEP 기본값은 `require-corp`다. 미리보기 어댑터가 없어도 부팅은 진행되고, 미리보기 이벤트만 오지 않는다.

### 어댑터 `/sdk/adapters`

`NuriteoServices`는 파일, 패키지, 미리보기, 프로젝트, 프로세스 어댑터를 옵션으로 받는다. 어댑터가 없으면 해당 호출은 실패한다. 이 페이지에 각 어댑터가 구현해야 하는 메서드와 `SdkError` 코드를 적는다.

`onTrace`는 카테고리, 연산, 시작·성공·실패, 시각을 낸다.

### 소비자 빌드에서 확인할 것

SDK 문서의 각 사용 예는 로컬 소비자 테스트와 같은 경계를 설명한다.

- TypeScript `moduleResolution: Bundler`로 루트 타입을 가져온다.
- CommonJS `require`로 `createContainer`, `createPreviewRelay`, `protocolVersion`을 본다.
- Vite, Webpack, Rspack, Next 앱이 루트 패키지를 빌드한다.
- Webpack, Rspack의 워커 주소는 `location.href` 기준이다.
- Next는 `transpilePackages`와 클라이언트 컴포넌트를 쓴다.

이 검사는 저장소의 `pnpm test:sdk-consumer`다. 레지스트리의 `@beta`를 받아 설치하는 검사는 아직 없다. 문서에 그 검사를 있는 것처럼 쓰지 않는다.

## 보안 `/security`

취약점 보고 창구와 심각도별 응답 시간. 본문은 `docs/security/vulnerability-and-incident-response.md`와 같다.

운영 중 장애 절차의 공개 요약은 `docs/release/incident-playbook.md`를 가리킨다. 지원 묶음은 자동으로 업로드되지 않는다. 문서에 수집하는 항목과 올리지 않는 항목을 적는다.

## 개발

기여자가 저장소를 빌드하고 검사하는 문서다. 릴리스 게이트의 통과 판정이나 비공개 태스크 목록은 넣지 않는다.

### 개발 개요 `/develop`

모노레포는 pnpm과 Cargo다. 제품 앱은 `apps/web`이다. 문서 사이트는 `apps/docs`이고 제품 서버 없이 빌드된다. SDK 발행물은 `packages/sdk`에서 `pnpm package:sdk`로 만든다.

### 저장소 지도 `/develop/repository`

| 경로 | 역할 |
|---|---|
| `apps/web` | Next.js 스튜디오와 브라우저 BFF |
| `apps/docs` | 공개 문서 SPA |
| `packages/sdk` | `@nuriteo/sdk` 입구 |
| `packages/protocol` | 브라우저와 워커 메시지 |
| `packages/browser-host` | OPFS, 프로세스, 권한 호스트 |
| `packages/node-runtime` | 브라우저 안 Node 호환 런타임 |
| `packages/preview` | HMR과 서비스 워커 |
| `packages/workspace-runtime` | 스튜디오 세션 |
| `packages/workers` | 시스템, 프로세스, CLI 워커. 다른 패키지가 직접 가져오지 않는다 |
| `packages/api-client` | Core 클라이언트 |
| `crates/nuriteo-server` | Rust Core |
| `crates/system-core`, `crates/system-wasm` | WASM 시스템 |
| `compat/` | 런타임 계약 |
| `deploy/` | Compose, 이미지, Helm |
| `release/` | 릴리스 기록과 게이트 |
| `docs/` | 검사가 읽는 공개 운영 문서 몇 개 |

생성된 `node_modules`, `target`, `dist`, `artifacts`, `.next`, `.pnpm-store`, `.local`은 커밋하지 않는다.

### 로컬 개발 `/develop/local`

`/install/source`와 같은 명령으로 띄운다. 이 페이지는 그 명령이 개발 루프에서 무엇을 재시작하는지, Web만 다시 띄우는 방법, 스택을 지우는 방법을 코드 변경 기준으로 적는다.

브라우저에서 확인할 경로는 제품과 같다. 데스크톱 Chrome, Vite 프로젝트를 열고 설치하고 편집하고 미리보기가 남는지.

### 검사와 테스트 `/develop/checks`

자주 쓰는 검사:

- `pnpm check:workspace`
- `pnpm check:types`
- `pnpm test:web`
- `pnpm test:workspace-runtime`
- `cargo test --workspace`
- `pnpm test:sdk-consumer` (`pnpm package:sdk` 이후)

CI의 빠른 검사는 워크스페이스, 개발 스택, 셀프호스트 베이스라인, 타입, 테스트다. 기획 문서가 빠져 건너뛰는 릴리스 검사는 기여자 첫 페이지에 나열하지 않는다.

### SDK 빌드와 배포 `/develop/sdk-release`

`pnpm package:sdk`는 WASM을 빌드하고 `dist/sdk/package`와 tarball을 만든다. `dist/`는 git에 들어가지 않는다.

npm 배포는 `main`에서 **Publish SDK** workflow를 수동 실행할 때다. GitHub OIDC로 배포하고, 저장소 시크릿에 npm 토큰을 두지 않는다. 태그는 `beta`다. 첫 배포 뒤 npm이 패키지를 검사하는 동안에는 같은 버전을 다시 올리지 않는다.

Trusted Publisher는 npm 조직 `nuriteo`의 `@nuriteo/sdk`에 연결된다. GitHub 저장소 주인은 `ByeongGi`, 저장소 이름은 `nuriteo`, workflow 파일은 `publish-sdk.yml`이다.

## 페이지에 공통으로 둘 것

- 제목, 한 문단 요약, 그 페이지에서 할 수 있는 일
- 이전·다음 페이지
- 한국어와 영어 전환
- 테마: 라이트, 다크, 시스템
- 코드 블록은 고정폭
- 지원 범위 밖 기능은 해당 페이지에서 짧게 말하고 `/limits`로 보낸다

첫 구현에 넣을 페이지는 소개, 소스 실행, 사용 개요, 지원 범위, SDK 개요, SDK 설치, 보안, 개발 개요다. Compose, Helm, SDK 레퍼런스, 개발 세부 페이지는 같은 주소 체계로 이어서 채운다.
