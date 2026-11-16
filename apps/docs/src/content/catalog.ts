import {
  containerApi,
  errorApi,
  filesystemApi,
  packagesApi,
  previewApi,
  processesApi,
  projectsApi,
  webcontainerApi
} from "./sdk-api.ts";
import { loadExamples } from "../example/cases/load-examples.ts";
import { mountCaseSource } from "../example/cases/mount-source.ts";
import type { Block, DocEntry } from "./types.ts";

const repo = "https://github.com/ByeongGi/nuriteo/blob/main";

function loadExampleBlocks(lang: "ko" | "en"): Block[] {
  return loadExamples[lang].map((example) => ({
    type: "example",
    title: example.title,
    text: example.text,
    code: example.code,
    result: example.result
  }));
}

export const catalog: DocEntry[] = [
  {
    path: "/",
    group: { ko: "소개", en: "Overview" },
    ko: {
      nav: "소개",
      eyebrow: "브라우저 네이티브 개발 환경",
      title: "코드를 열고, 바로 실행하세요.",
      lead: "NURITEO는 브라우저에서 프로젝트를 열고, 설치하고, 고치고, 실행하고, 미리보기로 결과를 보는 오픈 소스 개발 환경입니다. 이 저장소의 제품은 셀프호스트입니다. 매니지드 클라우드, 라이선스 키, 전화 홈 활성화는 없습니다. 라이선스는 Apache-2.0입니다.",
      blocks: [
        { type: "p", text: "지원되는 하루 경과는 데스크톱 Chrome에서 Vite 프로젝트를 열고, 선언된 패키지를 설치하고, 편집하고, 미리보기가 갱신되는 것입니다." },
        { type: "h2", text: "지원되는 하루" },
        { type: "steps", items: [
          { title: "프로젝트를 엽니다", text: "서명한 뒤 워크스페이스에서 프로젝트를 만들거나 엽니다. 시작 템플릿의 추천은 Vite + React입니다." },
          { title: "선언된 패키지를 설치합니다", text: "Studio에서 미리보기 실행을 누르면 그 프로젝트가 선언한 의존성을 설치하고 개발 서버를 준비합니다." },
          { title: "파일을 고칩니다", text: "파일 트리에서 고친 내용은 로컬 초안으로 미리보기에 반영됩니다." },
          { title: "서버에 남깁니다", text: "서버에 저장을 누르거나 Ctrl+S(macOS는 ⌘S)를 누르면 그 초안이 프로젝트 파일로 남습니다." }
        ] },
        { type: "h2", text: "어디서 시작할지" },
        { type: "links", items: [
          { to: "/guide", label: "문서 사용법", detail: "검색, 언어, 테마, 코드 복사, SDK 샌드박스를 이 사이트에서 쓰는 방법입니다." },
          { to: "/install", label: "인스턴스 설치", detail: "Compose, Helm, 또는 소스에서 Web과 Core를 올립니다." },
          { to: "/use", label: "브라우저에서 사용", detail: "데스크톱 Chrome에서 Vite 프로젝트를 열고 미리보기를 봅니다." },
          { to: "/sdk", label: "@nuriteo/sdk로 런타임 붙이기", detail: "브라우저 페이지 안에서 파일, 패키지, 미리보기를 호출합니다." }
        ] }
      ]
    },
    en: {
      nav: "Overview",
      eyebrow: "Browser-native development",
      title: "Open a project and run it.",
      lead: "NURITEO is an open-source environment for opening a project in the browser, installing its packages, editing, running, and seeing the result in Preview. This repository ships the self-hosted product. Managed cloud, license keys, and phone-home activation are out of scope. The license is Apache-2.0.",
      blocks: [
        { type: "p", text: "The supported day is desktop Chrome: open a Vite project, install its declared packages, edit, and watch Preview update." },
        { type: "h2", text: "The supported day" },
        { type: "steps", items: [
          { title: "Open a project", text: "After sign-in, create or open a project from the workspace. The recommended starting template is Vite + React." },
          { title: "Install declared packages", text: "In Studio, 미리보기 실행 installs the dependencies that project declares and prepares the dev server." },
          { title: "Edit a file", text: "A change in the file tree is a local draft, and Preview picks it up." },
          { title: "Keep it on the server", text: "Use 서버에 저장, or press Ctrl+S (⌘S on macOS), to keep that draft as a project file." }
        ] },
        { type: "h2", text: "Where to start" },
        { type: "links", items: [
          { to: "/guide", label: "Using these docs", detail: "Search, language, theme, code copy, and the SDK sandbox on this site." },
          { to: "/install", label: "Install an instance", detail: "Run Web and Core with Compose, Helm, or from source." },
          { to: "/use", label: "Use it in the browser", detail: "Open a Vite project on desktop Chrome and watch Preview." },
          { to: "/sdk", label: "Embed the runtime with @nuriteo/sdk", detail: "Call files, packages, and Preview from a browser page." }
        ] }
      ]
    }
  },
  {
    path: "/guide",
    group: { ko: "소개", en: "Overview" },
    ko: {
      nav: "문서 사용법",
      eyebrow: "소개",
      title: "이 문서 사이트에서 찾는 법과 실행하는 법입니다.",
      lead: "같은 주소에서 한국어와 영어를 바꿉니다. 검색은 지금 보고 있는 언어의 제목, 본문, 기호를 찾습니다. SDK 샌드박스는 /sdk 에서만 실행됩니다.",
      blocks: [
        { type: "h2", text: "언어와 테마" },
        { type: "ul", items: [
          "머리글의 English는 영어 본문으로, 한국어는 한국어 본문으로 바꿉니다. 주소는 그대로입니다.",
          "테마 버튼은 시스템, 라이트, 다크 순서로 바뀝니다. 선택은 이 브라우저에 남습니다.",
          "첫 키보드 탭의 본문으로 링크는 머리글을 건너뜁니다."
        ] },
        { type: "h2", text: "검색과 목차" },
        { type: "ul", items: [
          "머리글의 검색, 또는 넓은 화면에서 왼쪽 목차 위의 검색을 누릅니다. Ctrl K, macOS는 ⌘K, 입력란 밖에서의 / 도 검색을 엽니다.",
          "위아래 화살표로 결과를 고르고 Enter로 그 페이지를 엽니다. Esc는 검색을 닫습니다.",
          "검색은 다른 언어의 문장을 찾지 않습니다. 영어 페이지를 찾으려면 먼저 English로 바꿉니다.",
          "넓은 화면의 머리글은 소개, 설치, 사용, 지원 범위, SDK, 보안, 개발 구역으로 이동합니다. 왼쪽 목차는 그 구역의 페이지입니다.",
          "좁은 화면의 목차 버튼이 같은 목록을 엽니다.",
          "이 페이지는 오른쪽, 좁은 화면에서는 본문 위의 접힌 목록입니다. 보이는 절이 표시됩니다.",
          "페이지 끝의 이전과 다음은 카탈로그 순서입니다.",
          "없는 주소는 소개로 돌아가는 안내만 보여 줍니다."
        ] },
        { type: "h2", text: "코드" },
        { type: "p", text: "코드 블록의 복사를 누르면 그 블록 전체가 클립보드에 들어갑니다. 복사가 거부되면 버튼은 복사됨으로 바뀌지 않습니다. 본문의 고정폭은 기호 이름입니다." },
        { type: "h2", text: "SDK 샌드박스" },
        { type: "steps", items: [
          { title: "/sdk 를 엽니다", text: "샌드박스는 이 페이지에만 있습니다. 왼쪽 편집기 파일 이름은 sandbox.mjs 입니다." },
          { title: "격리를 확인합니다", text: "실행에는 Cross-Origin-Embedder-Policy: require-corp 와 Cross-Origin-Opener-Policy: same-origin 이 필요합니다. 개발 서버는 헤더를 직접 붙입니다. GitHub Pages는 서비스 워커가 같은 헤더를 더한 뒤 한 번 다시 엽니다. 격리가 없으면 예시는 복사할 수 있고, 부팅은 실행하지 않으며, 성공으로 표시하지 않습니다." },
          { title: "note 를 고칩니다", text: "편집기에 이미 createContainer 와 runtime 이 있습니다. note 를 바꾸면 오른쪽 샌드박스 결과의 고친 값이 그 문자열이 됩니다. 입력을 멈추면 다시 실행됩니다. 다시 실행은 바로 돌리고, 처음 코드는 예시를 되돌립니다." },
          { title: "런타임이 쓴 파일을 읽습니다", text: "기본 예시는 entrypoint fs-smoke 로 /workspace/result.txt 에 hello 를 씁니다. 그 파일은 5바이트로 남습니다. container.run 에 넣은 소스 문자열은 실행되지 않습니다. 런타임 안의 임의 JavaScript 평가가 막혀 있기 때문입니다." },
          { title: "페이지를 떠나면 컨테이너는 닫힙니다", text: "샌드박스가 연 컨테이너는 실행이 끝나면 teardown 됩니다. services.fs 같은 호출은 이 샌드박스가 어댑터를 붙이지 않으므로 제품 페이지의 파일 API가 아닙니다. 어댑터 예제는 각 SDK 페이지에 있습니다." }
        ] },
        { type: "h2", text: "이 사이트에 없는 것" },
        { type: "p", text: "릴리스 게이트의 통과 판정, 비공개 태스크 목록, 자격 증명의 값, 지원 묶음의 자동 업로드는 없습니다. 지원 범위 밖의 기능은 해당 페이지에서 짧게 말하고 /limits 로 보냅니다." },
        { type: "links", items: [
          { to: "/sdk", label: "SDK 샌드박스 열기" },
          { to: "/limits", label: "지원 범위" },
          { to: "/use", label: "브라우저에서 사용" }
        ] }
      ]
    },
    en: {
      nav: "Using these docs",
      eyebrow: "Overview",
      title: "How to search this site and run the sample.",
      lead: "Korean and English share the address. Search looks through the title, body, and symbols of the language you are reading. The SDK sandbox runs only on /sdk.",
      blocks: [
        { type: "h2", text: "Language and theme" },
        { type: "ul", items: [
          "English in the header switches the body to English. 한국어 switches it back. The address stays the same.",
          "The theme button cycles System, Light, and Dark. The choice stays in this browser.",
          "The first keyboard tab is Skip to content. It jumps past the header."
        ] },
        { type: "h2", text: "Search and contents" },
        { type: "ul", items: [
          "Use Search in the header, or the Search button above the left contents on a wide screen. Ctrl K, ⌘K on macOS, and / outside a text field also open search.",
          "Choose a result with the up and down arrows and open it with Enter. Esc closes search.",
          "Search does not look through the other language. Switch to English before searching English pages.",
          "On a wide screen the header jumps between Overview, Install, Use, Scope, SDK, Security, and Develop. The left contents list the pages in the current section.",
          "On a narrow screen the Contents button opens that same list.",
          "On this page sits on the right. On a narrow screen it is the collapsed list above the body. The visible section is marked.",
          "Previous and next at the end of a page follow the catalog order.",
          "An address that is not in the catalog only offers a link back to the overview."
        ] },
        { type: "h2", text: "Code" },
        { type: "p", text: "Copy on a code block puts that whole block on the clipboard. If the browser refuses the write, the button does not change to Copied. Monospace words in a paragraph are symbol names." },
        { type: "h2", text: "SDK sandbox" },
        { type: "steps", items: [
          { title: "Open /sdk", text: "The sandbox exists only on that page. The editor file is named sandbox.mjs." },
          { title: "Check isolation", text: "Running needs Cross-Origin-Embedder-Policy: require-corp and Cross-Origin-Opener-Policy: same-origin. The dev server sends those headers. GitHub Pages cannot, so a service worker adds them and reloads once. Without isolation the sample can be copied, boot does not run, and the page does not report success." },
          { title: "Change note", text: "createContainer and runtime are already in the editor. Change note and the edited value in the sandbox result becomes that string. The sample runs again after you pause. Run again starts it immediately. Reset restores the sample." },
          { title: "Read the file the runtime wrote", text: "The default sample uses the fs-smoke entrypoint and writes hello to /workspace/result.txt. That file stays 5 bytes. A source string passed to container.run does not execute, because arbitrary JavaScript evaluation inside the runtime is disabled." },
          { title: "Leaving the page closes the container", text: "The sandbox calls teardown when a run finishes. Calls such as services.fs are not the product file API here, because this sandbox does not attach adapters. Adapter examples are on the SDK pages." }
        ] },
        { type: "h2", text: "What this site leaves out" },
        { type: "p", text: "Release-gate verdicts, private task lists, credential values, and automatic upload of a support bundle are not here. A feature outside the supported path is named on its page and sent to /limits." },
        { type: "links", items: [
          { to: "/sdk", label: "Open the SDK sandbox" },
          { to: "/limits", label: "Supported scope" },
          { to: "/use", label: "Use it in the browser" }
        ] }
      ]
    }
  },
  {
    path: "/install",
    group: { ko: "설치", en: "Install" },
    ko: {
      nav: "설치 개요",
      eyebrow: "설치",
      title: "인스턴스를 어디에 올릴지 고릅니다.",
      lead: "운영자가 자기 인프라에 Web과 Core를 올립니다. 공통 구성은 Web, Core, PostgreSQL, 객체 저장소입니다. 객체 저장소는 RustFS 또는 S3 호환 저장소입니다. 브라우저에 열리는 것은 Web뿐입니다. 저장과 미리보기 트래픽은 애플리케이션 출처를 벗어나지 않습니다.",
      blocks: [
        { type: "p", text: "Node.js 24.17 이상 25 미만, pnpm 11.15 이상 12 미만, Rust 1.97은 소스 실행에만 해당합니다. 이미지로 올리는 Compose와 Helm은 그 버전을 호스트에 요구하지 않습니다." },
        { type: "links", items: [
          { to: "/install/source", label: "소스에서 실행", detail: "저장소를 고치면서 띄울 때 씁니다. pnpm dev가 Web과 Core를 같이 올립니다." },
          { to: "/install/compose", label: "단일 호스트 Compose", detail: "한 대에서 제품과 같은 경계로 실행합니다. Web만 호스트 포트를 엽니다." },
          { to: "/install/kubernetes", label: "Helm", detail: "Kubernetes 1.29 이상에서 Web과 Core를 한 릴리스로 올립니다. PostgreSQL은 차트 밖에 둡니다." },
          { to: "/install/admin", label: "첫 관리자", detail: "설치가 끝나면 관리자 한 명을 만듭니다. 이후 사용자는 초대로만 들어옵니다." }
        ] }
      ]
    },
    en: {
      nav: "Install",
      eyebrow: "Install",
      title: "Choose where the instance runs.",
      lead: "An operator runs Web and Core on their own infrastructure. The shared pieces are Web, Core, PostgreSQL, and object storage. Object storage is RustFS or S3-compatible storage. Only Web is opened in the browser. Save and Preview traffic stay on the application origin.",
      blocks: [
        { type: "p", text: "Node.js 24.17 up to but not including 25, pnpm 11.15 up to but not including 12, and Rust 1.97 apply only to the source path. Compose and Helm images do not ask the host for those versions." },
        { type: "links", items: [
          { to: "/install/source", label: "Run from source", detail: "Use this while changing the repository. pnpm dev starts Web and Core together." },
          { to: "/install/compose", label: "Single-host Compose", detail: "Run the product boundary on one host. Only Web publishes a host port." },
          { to: "/install/kubernetes", label: "Helm", detail: "Deploy Web and Core as one release on Kubernetes 1.29 or newer. PostgreSQL stays outside the chart." },
          { to: "/install/admin", label: "First administrator", detail: "After install, create one administrator. Later people enter only by invite." }
        ] }
      ]
    }
  },
  {
    path: "/install/source",
    group: { ko: "설치", en: "Install" },
    ko: {
      nav: "소스에서 실행",
      eyebrow: "설치",
      title: "저장소를 클론하고 개발 서버를 띄웁니다.",
      lead: "이 경로는 기여자와 소스를 직접 실행하는 운영자를 위한 것입니다. 이미지로 올리는 절차는 Compose와 Helm에 있습니다.",
      blocks: [
        { type: "example", title: "개발 서버를 띄웁니다", text: "저장소 루트에서 의존성을 설치한 뒤 Web과 Core를 함께 띄웁니다. PostgreSQL과 RustFS는 컨테이너로 남고, Core는 Rust 소스가 바뀌면 다시 빌드됩니다.", code: "git clone https://github.com/ByeongGi/nuriteo.git\ncd nuriteo\npnpm install\npnpm dev", result: "Web은 http://127.0.0.1:3000 에서 Next.js HMR로 갱신됩니다. Ctrl-C는 Core와 Web만 멈추고 데이터 컨테이너는 남깁니다." },
        { type: "p", text: "Node.js 24.17 이상 25 미만, pnpm 11.15 이상 12 미만, Rust 1.97이 필요합니다." },
        { type: "ul", items: [
          "pnpm dev:backend 는 Core와 데이터 스택입니다.",
          "pnpm dev:web 은 Web만 띄웁니다. pnpm dev:fe 는 같은 명령입니다.",
          "pnpm dev:stack, dev:stack:status, dev:stack:credentials, dev:stack:down, dev:stack:reset 으로 데이터 스택을 다룹니다."
        ] },
        { type: "p", text: "개발 자격과 TLS는 .local/nuriteo-compose 에 생깁니다. 이 값은 로컬 전용입니다. dev:stack:down 은 데이터를 남기고, dev:stack:reset 만 데이터와 인증정보를 지웁니다." },
        { type: "callout", tone: "limit", title: "데이터를 지우는 명령", text: "`pnpm dev:stack:reset` 만 데이터와 인증정보를 지웁니다. `pnpm dev:stack:down` 과 Ctrl-C는 데이터를 남깁니다." },
        { type: "h2", text: "확인" },
        { type: "p", text: "Web이 뜨면 데스크톱 Chrome에서 http://127.0.0.1:3000 을 엽니다. 그 다음은 사용 문서의 Vite 경로입니다." },
        { type: "links", items: [{ to: "/use", label: "브라우저에서 사용" }] }
      ]
    },
    en: {
      nav: "Run from source",
      eyebrow: "Install",
      title: "Clone the repository and start the dev server.",
      lead: "This path is for contributors and operators who run the source directly. Image installs are Compose and Helm.",
      blocks: [
        { type: "example", title: "Start the dev server", text: "From the repository root, install dependencies and start Web and Core together. PostgreSQL and RustFS stay in containers. Core rebuilds when Rust sources change.", code: "git clone https://github.com/ByeongGi/nuriteo.git\ncd nuriteo\npnpm install\npnpm dev", result: "Web refreshes through Next.js HMR at http://127.0.0.1:3000. Ctrl-C stops Core and Web and leaves the data containers running." },
        { type: "p", text: "Node.js 24.17 up to but not including 25, pnpm 11.15 up to but not including 12, and Rust 1.97 are required." },
        { type: "ul", items: [
          "pnpm dev:backend runs Core and the data stack.",
          "pnpm dev:web runs Web only. pnpm dev:fe is the same command.",
          "pnpm dev:stack, dev:stack:status, dev:stack:credentials, dev:stack:down, and dev:stack:reset operate the data stack."
        ] },
        { type: "p", text: "Development credentials and TLS are written under .local/nuriteo-compose. Those values are local only. dev:stack:down keeps data. dev:stack:reset deletes data and credentials." },
        { type: "callout", tone: "limit", title: "The command that deletes data", text: "Only `pnpm dev:stack:reset` deletes data and credentials. `pnpm dev:stack:down` and Ctrl-C keep the data." },
        { type: "h2", text: "Check" },
        { type: "p", text: "When Web is up, open http://127.0.0.1:3000 in desktop Chrome. Continue with the Vite path in the use pages." },
        { type: "links", items: [{ to: "/use", label: "Use it in the browser" }] }
      ]
    }
  },
  {
    path: "/install/compose",
    group: { ko: "설치", en: "Install" },
    ko: {
      nav: "Compose",
      eyebrow: "설치",
      title: "한 대에서 공식 단일 호스트 구성을 띄웁니다.",
      lead: "Web만 호스트 포트를 엽니다. Core, PostgreSQL, RustFS는 Compose DNS와 내부 네트워크를 씁니다. 묶인 RustFS는 브라우저에 노출되지 않습니다.",
      blocks: [
        { type: "example", title: "스택을 올립니다", text: "저장소 루트에서 파일 변수를 절대 경로로 둔 뒤 실행합니다. Compose 파일에는 자격 증명 기본값이 없습니다. 비밀번호, TLS, 미리보기 서명 키, 통합 자격 마스터 키의 값은 문서에 적지 않습니다. 공식 수용 경계는 Linux의 Docker Compose v2입니다.", code: "docker compose -f deploy/compose/compose.yaml up", result: "PostgreSQL과 RustFS가 준비된 뒤 버킷 준비, 앞으로만 가는 마이그레이션, 첫 관리자, Core, Web 순서로 뜹니다. 앞 단계가 실패하면 Core와 Web은 뜨지 않습니다. Web 기본 바인드는 127.0.0.1의 3000번 포트입니다." },
        { type: "h2", text: "필요한 파일" },
        { type: "ul", items: [
          "NURITEO_POSTGRES_PASSWORD_FILE, NURITEO_POSTGRES_SERVER_CERT_FILE, NURITEO_POSTGRES_SERVER_KEY_FILE",
          "NURITEO_DATABASE_URL_FILE, NURITEO_DATABASE_CA_FILE",
          "NURITEO_RUSTFS_ACCESS_KEY_FILE, NURITEO_RUSTFS_SECRET_KEY_FILE, NURITEO_RUSTFS_CA_FILE, NURITEO_RUSTFS_TLS_DIR",
          "NURITEO_BOOTSTRAP_ADMIN_EMAIL, NURITEO_BOOTSTRAP_ADMIN_NAME, NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE",
          "NURITEO_EXTERNAL_URL, NURITEO_PREVIEW_BASE_DOMAIN",
          "NURITEO_PREVIEW_SIGNING_KEY_FILE, NURITEO_MASTER_KEY_FILE, NURITEO_MASTER_KEY_VERSION"
        ] },
        { type: "p", text: "데이터는 compose down 뒤에도 볼륨에 남습니다. 데이터를 지울 때만 compose down --volumes 를 씁니다." },
        { type: "h2", text: "외부 S3" },
        { type: "example", title: "외부 버킷을 확인합니다", text: "브라우저가 버킷에 직접 붙지 않습니다. 묶인 버킷의 CORS 정리와 외부 버킷의 CORS 계약을 섞어 쓰지 않습니다. 외부 버킷은 미리 있어야 합니다.", code: "docker compose -f deploy/compose/compose.external-s3.yaml run --rm storage-check", result: "이 검사는 읽기 전용입니다. 버킷을 만들거나 CORS를 고치지 않습니다." },
        { type: "p", text: "업그레이드 명령은 업그레이드 페이지에 있습니다." },
        { type: "links", items: [{ to: "/install/upgrade", label: "업그레이드" }] }
      ]
    },
    en: {
      nav: "Compose",
      eyebrow: "Install",
      title: "Run the official single-host topology.",
      lead: "Only Web publishes a host port. Core, PostgreSQL, and RustFS use Compose DNS and an internal network. Bundled RustFS has no browser endpoint.",
      blocks: [
        { type: "example", title: "Start the stack", text: "From the repository root, point the file variables below at absolute paths, then start the stack. The Compose file has no credential defaults. This page does not show passwords, TLS material, the Preview signing key, or the integration master key. Official acceptance is Docker Compose v2 on Linux.", code: "docker compose -f deploy/compose/compose.yaml up", result: "Startup waits until PostgreSQL and RustFS are ready, then prepares the bucket, applies forward-only migrations, creates the first administrator, and starts Core and then Web. A failed earlier step keeps Core and Web down. Web binds 127.0.0.1 port 3000 by default." },
        { type: "h2", text: "Required files" },
        { type: "ul", items: [
          "NURITEO_POSTGRES_PASSWORD_FILE, NURITEO_POSTGRES_SERVER_CERT_FILE, NURITEO_POSTGRES_SERVER_KEY_FILE",
          "NURITEO_DATABASE_URL_FILE, NURITEO_DATABASE_CA_FILE",
          "NURITEO_RUSTFS_ACCESS_KEY_FILE, NURITEO_RUSTFS_SECRET_KEY_FILE, NURITEO_RUSTFS_CA_FILE, NURITEO_RUSTFS_TLS_DIR",
          "NURITEO_BOOTSTRAP_ADMIN_EMAIL, NURITEO_BOOTSTRAP_ADMIN_NAME, NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE",
          "NURITEO_EXTERNAL_URL, NURITEO_PREVIEW_BASE_DOMAIN",
          "NURITEO_PREVIEW_SIGNING_KEY_FILE, NURITEO_MASTER_KEY_FILE, NURITEO_MASTER_KEY_VERSION"
        ] },
        { type: "p", text: "Data remains in volumes after compose down. Use compose down --volumes only when the data should go away." },
        { type: "h2", text: "External S3" },
        { type: "example", title: "Check an external bucket", text: "The browser does not talk to the bucket directly. Do not mix the bundled bucket CORS cleanup with the external bucket CORS contract. The external bucket must already exist.", code: "docker compose -f deploy/compose/compose.external-s3.yaml run --rm storage-check", result: "The check is read-only. It does not create the bucket or change CORS." },
        { type: "p", text: "Upgrade commands are on the upgrade page." },
        { type: "links", items: [{ to: "/install/upgrade", label: "Upgrade" }] }
      ]
    }
  },
  {
    path: "/install/kubernetes",
    group: { ko: "설치", en: "Install" },
    ko: {
      nav: "Helm",
      eyebrow: "설치",
      title: "Kubernetes에는 차트로 Web과 Core를 한 릴리스로 올립니다.",
      lead: "차트는 deploy/charts/nuriteo 입니다. Kubernetes 1.29 이상입니다. PostgreSQL은 차트 밖에 둡니다. 운영 저장소는 외부 HTTPS S3 호환 저장소입니다.",
      blocks: [
        { type: "example", title: "한 릴리스로 설치합니다", text: "비공개 values 파일에는 시크릿 값을 넣지 않습니다. 이미 있는 Secret의 이름과 키만 가리킵니다. 이미지 참조는 sha256 다이제스트이고, 바뀌는 태그는 쓰지 않습니다.", code: "helm upgrade --install nuriteo deploy/charts/nuriteo \\\n  --namespace nuriteo \\\n  --create-namespace \\\n  -f values.yaml", result: "차트는 저장소 검사 또는 업그레이드 사전 검사, 앞으로만 가는 마이그레이션, 선택적인 첫 관리자 작업을 순서대로 돌린 다음 Web과 Core를 만듭니다. 훅이 실패하면 새 Deployment가 적용되기 전에 Helm이 멈추고, 이전 릴리스가 남습니다." },
        { type: "ul", items: [
          "postgresql.existingSecret: 데이터베이스 URL과 선택적인 CA",
          "objectStorage.existingSecret: S3 자격",
          "applicationSecrets.existingSecret: 마스터 키, 저장 멱등 키, 미리보기 서명 키",
          "bootstrapAdmin.existingSecret: 첫 관리자 비밀번호. bootstrap을 켤 때만"
        ] },
        { type: "p", text: "애플리케이션 주소는 HTTPS 출처의 / 이고, 하위 경로 배포는 지원하지 않습니다." }
      ]
    },
    en: {
      nav: "Helm",
      eyebrow: "Install",
      title: "Deploy Web and Core as one Helm release.",
      lead: "The chart is deploy/charts/nuriteo. Kubernetes 1.29 or newer is required. PostgreSQL stays outside the chart. Production storage is external HTTPS S3-compatible storage.",
      blocks: [
        { type: "example", title: "Install one release", text: "Keep secret values out of the private values file. Point it at an existing Secret by name and key. Image references are sha256 digests. Mutable tags are not used.", code: "helm upgrade --install nuriteo deploy/charts/nuriteo \\\n  --namespace nuriteo \\\n  --create-namespace \\\n  -f values.yaml", result: "The chart runs a storage check or upgrade preflight, forward-only migration, and the optional first-administrator job, then creates Web and Core. A failed hook stops Helm before the new Deployments are applied and leaves the previous release in place." },
        { type: "ul", items: [
          "postgresql.existingSecret: database URL and optional CA",
          "objectStorage.existingSecret: S3 credentials",
          "applicationSecrets.existingSecret: master key, save idempotency key, and Preview signing key",
          "bootstrapAdmin.existingSecret: first administrator password, only when bootstrap is enabled"
        ] },
        { type: "p", text: "The application origin is an HTTPS origin at /. Subpath deployment is not supported." }
      ]
    }
  },
  {
    path: "/install/admin",
    group: { ko: "설치", en: "Install" },
    ko: {
      nav: "첫 관리자",
      eyebrow: "설치",
      title: "인스턴스 관리자 한 명을 만든 뒤 초대로 사용자를 받습니다.",
      lead: "설치가 끝나면 인스턴스 관리자 한 명이 필요합니다. Compose와 Helm 모두 bootstrap으로 이메일, 표시 이름, 비밀번호 파일을 받습니다.",
      blocks: [
        { type: "example", title: "bootstrap이 읽는 이름", text: "Compose는 환경 이름으로, Helm은 bootstrapAdmin.existingSecret으로 같은 세 값을 받습니다. 비밀번호 파일의 내용은 문서에 적지 않습니다.", code: "NURITEO_BOOTSTRAP_ADMIN_EMAIL\nNURITEO_BOOTSTRAP_ADMIN_NAME\nNURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE", result: "이미 만들어진 관리자는 재시작해도 비밀번호가 다시 쓰이지 않습니다." },
        { type: "steps", items: [
          { title: "스택이 관리자 한 명을 만듭니다", text: "bootstrap이 이메일, 표시 이름, 비밀번호 파일로 계정을 만듭니다." },
          { title: "그 계정으로 서명합니다", text: "Web 출처를 엽니다. 서명 폼은 POST이고, 비밀번호는 URL에 실리지 않습니다." },
          { title: "다음 사람은 초대로 들어옵니다", text: "공개 가입 페이지는 없습니다." }
        ] }
      ]
    },
    en: {
      nav: "First administrator",
      eyebrow: "Install",
      title: "Create one instance administrator, then invite people.",
      lead: "An install needs one instance administrator. Compose and Helm both take an email, a display name, and a password file through bootstrap.",
      blocks: [
        { type: "example", title: "Names bootstrap reads", text: "Compose reads these names from the environment. Helm reads the password from bootstrapAdmin.existingSecret. The password file contents are not written on this page.", code: "NURITEO_BOOTSTRAP_ADMIN_EMAIL\nNURITEO_BOOTSTRAP_ADMIN_NAME\nNURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE", result: "A later restart does not rewrite the password of an administrator that already exists." },
        { type: "steps", items: [
          { title: "The stack creates one administrator", text: "Bootstrap makes the account from the email, the display name, and the password file." },
          { title: "Sign in with that account", text: "Open the Web origin. The sign-in form is POST, and the password is not placed in the URL." },
          { title: "The next person enters by invite", text: "There is no public signup page." }
        ] }
      ]
    }
  },
  {
    path: "/install/upgrade",
    group: { ko: "설치", en: "Install" },
    ko: {
      nav: "업그레이드",
      eyebrow: "설치",
      title: "데이터베이스 변경은 앞으로만 갑니다.",
      lead: "롤백은 Core와 Web 이미지를 이전으로 되돌리는 절차입니다. 스키마를 다운그레이드하지 않습니다. 스키마나 객체를 되돌려야 하면 복원입니다.",
      blocks: [
        { type: "example", title: "업그레이드와 롤백", text: "릴리스 계획을 만든 뒤 저장소 루트에서 실행합니다. 도우미는 읽기 전용 사전 검사, 객체 저장소 확인, 앞으로만 가는 마이그레이션, Core 교체, Web 교체 순서입니다.", code: "node deploy/compose/upgrade.mjs upgrade /absolute/path/to/upgrade-plan.json\nnode deploy/compose/upgrade.mjs rollback /absolute/path/to/upgrade-plan.json", result: "마이그레이션 전에 실패하면 워크로드는 바뀌지 않습니다. 롤백은 이전 Core와 Web으로만 되돌립니다. 다운 마이그레이션은 없습니다. 스키마나 객체를 되돌려야 하면 복원입니다. SDK 배포 채널을 되돌리면 채널 포인터만 바뀌고, 이미 설치된 데이터베이스는 다시 쓰이지 않습니다." }
      ]
    },
    en: {
      nav: "Upgrade",
      eyebrow: "Install",
      title: "Database changes only move forward.",
      lead: "Rollback restores the previous Core and Web images. It does not downgrade the schema. Restoring schema or objects is a restore.",
      blocks: [
        { type: "example", title: "Upgrade and roll back", text: "After you write a release plan, run the helper from the repository root. It runs a read-only preflight, an object-storage check, forward-only migration, Core replacement, then Web replacement.", code: "node deploy/compose/upgrade.mjs upgrade /absolute/path/to/upgrade-plan.json\nnode deploy/compose/upgrade.mjs rollback /absolute/path/to/upgrade-plan.json", result: "A failure before migration leaves the workloads unchanged. Rollback returns only to the previous Core and Web. There is no down migration. Restoring schema or objects is a restore. Moving an SDK release channel changes the channel pointer. An installed database is not rewritten." }
      ]
    }
  },
  {
    path: "/use",
    group: { ko: "사용", en: "Use" },
    ko: {
      nav: "사용 개요",
      eyebrow: "사용",
      title: "서명한 뒤 Vite 프로젝트를 열고 미리보기를 봅니다.",
      lead: "데스크톱 Chrome에서 서명 이후의 하루 경과입니다. 워크스페이스에서 프로젝트를 엽니다.",
      blocks: [
        { type: "p", text: "되는 경로는 데스크톱 Chrome에서 다음 순서입니다. 매니지드 클라우드나 임의의 npm 전체는 이 경로에 없습니다. 제품 화면의 단추 이름은 한국어입니다." },
        { type: "steps", items: [
          { title: "서명합니다", text: "Web 출처를 엽니다. 공개 가입은 없습니다. 계정은 첫 관리자이거나 관리자 초대입니다." },
          { title: "Vite + React로 프로젝트를 만듭니다", text: "프로젝트 만들기에서 이름과 시작 템플릿을 정합니다. 추천 템플릿은 Vite + React입니다. Next.js 템플릿도 고를 수 있지만, 지원하는 하루 경과는 Vite입니다. 템플릿은 만든 뒤 바꾸지 못합니다." },
          { title: "미리보기 실행을 누릅니다", text: "Studio가 열리면 미리보기 실행이 선언된 의존성을 설치하고 개발 서버를 준비합니다. 터미널에 의존성 설치 중, 이어서 개발 서버 준비 완료가 표시됩니다." },
          { title: "파일을 고치고 서버에 저장합니다", text: "파일 트리의 변경은 로컬 초안이고 미리보기에 반영됩니다. 서버에 저장을 누르거나 Ctrl+S(macOS는 ⌘S)를 눌러야 프로젝트 파일로 남습니다." }
        ] },
        { type: "h2", text: "로컬 초안과 서버 저장" },
        { type: "table", columns: ["시점", "남는 곳"], rows: [
          ["파일을 고친 직후", "로컬 초안입니다. 미리보기는 그 초안을 보여 주고, 서버의 프로젝트 파일은 이전 내용입니다."],
          ["서버에 저장한 뒤", "프로젝트 파일입니다. 다음에 열어도 그 내용이 있습니다."]
        ] },
        { type: "links", items: [
          { to: "/use/projects", label: "프로젝트" },
          { to: "/use/preview", label: "미리보기" },
          { to: "/use/files", label: "파일과 터미널" },
          { to: "/limits", label: "지원 범위" }
        ] }
      ]
    },
    en: {
      nav: "Use",
      eyebrow: "Use",
      title: "After sign-in, open a Vite project and watch Preview.",
      lead: "This is the day after sign-in on desktop Chrome. Open a project from the workspace.",
      blocks: [
        { type: "p", text: "The path that works on desktop Chrome is the sequence below. Managed cloud and arbitrary npm as a whole are not part of it. Button names in the product are Korean." },
        { type: "steps", items: [
          { title: "Sign in", text: "Open the Web origin. There is no public signup. The account is the first administrator or an administrator invite." },
          { title: "Create a Vite + React project", text: "On 프로젝트 만들기, set the name and the starting template. The recommended template is Vite + React. Next.js can be chosen too, and the supported day remains Vite. A template cannot be changed after creation." },
          { title: "Press 미리보기 실행", text: "After Studio opens, 미리보기 실행 installs the declared dependencies and prepares the dev server. The terminal shows 의존성 설치 중, then 개발 서버 준비 완료." },
          { title: "Edit, then save to the server", text: "A file-tree edit is a local draft and Preview picks it up. Press 서버에 저장, or Ctrl+S (⌘S on macOS), to keep it as a project file." }
        ] },
        { type: "h2", text: "A local draft and a server save" },
        { type: "table", columns: ["When", "Where it lives"], rows: [
          ["Just after an edit", "A local draft. Preview shows that draft. The project file on the server is still the previous content."],
          ["After 서버에 저장", "A project file. Opening the project again shows that content."]
        ] },
        { type: "links", items: [
          { to: "/use/projects", label: "Projects" },
          { to: "/use/preview", label: "Preview" },
          { to: "/use/files", label: "Files and the terminal" },
          { to: "/limits", label: "Supported scope" }
        ] }
      ]
    }
  },
  {
    path: "/use/projects",
    group: { ko: "사용", en: "Use" },
    ko: {
      nav: "프로젝트",
      eyebrow: "사용",
      title: "프로젝트를 열면 저장한 파일이 남습니다.",
      lead: "프로젝트를 만들거나 엽니다. 템플릿 또는 가져온 묶음에서 시작할 수 있습니다.",
      blocks: [
        { type: "steps", items: [
          { title: "프로젝트 만들기를 엽니다", text: "이름과 시작 템플릿을 정한 뒤 프로젝트 만들기를 누릅니다. 추천은 Vite + React입니다. 이미 있는 프로젝트는 목록에서 Studio로 엽니다. 가져온 묶음에서 시작할 수도 있습니다." },
          { title: "템플릿이 고정됩니다", text: "만든 뒤에는 시작 템플릿을 바꾸지 못합니다. 다른 프레임워크가 필요하면 새 프로젝트를 만듭니다. 저장본이 없으면 Studio는 그 템플릿으로 파일을 준비합니다." },
          { title: "로컬 초안과 서버 저장을 구분합니다", text: "편집기에서 고친 내용은 먼저 로컬 초안입니다. 서버에 저장이 끝난 뒤에야 그 내용이 프로젝트 파일로 남습니다. 저장 전에 서버 프로젝트가 바뀌면 로컬 초안은 보존되고, 최신 프로젝트를 불러온 뒤 다시 저장합니다." }
        ] },
        { type: "callout", tone: "limit", text: "패키지 설치는 그 프로젝트가 선언한 의존성만 대상으로 합니다. 선언되지 않은 패키지를 임의로 받는 경로는 지원 범위 밖입니다." },
        { type: "links", items: [{ to: "/limits", label: "지원 범위" }] }
      ]
    },
    en: {
      nav: "Projects",
      eyebrow: "Use",
      title: "A saved edit stays in the project file.",
      lead: "Create or open a project. You can start from a template or an imported bundle.",
      blocks: [
        { type: "steps", items: [
          { title: "Open 프로젝트 만들기", text: "Set the name and the starting template, then press 프로젝트 만들기. The recommendation is Vite + React. An existing project opens into Studio from the list. A project can also start from an imported bundle." },
          { title: "The template stays fixed", text: "The starting template cannot be changed later. Create another project when a different framework is required. When no server copy exists, Studio prepares files from that template." },
          { title: "Tell a local draft from a server save", text: "An editor change is a local draft first. It stays as a project file after 서버에 저장 finishes. If the server project changed before that save, the local draft is kept and the latest project has to be loaded before saving again." }
        ] },
        { type: "callout", tone: "limit", text: "Package installation targets only the dependencies that project declares. Installing packages it does not declare is outside the supported path." },
        { type: "links", items: [{ to: "/limits", label: "Supported scope" }] }
      ]
    }
  },
  {
    path: "/use/preview",
    group: { ko: "사용", en: "Use" },
    ko: {
      nav: "미리보기",
      eyebrow: "사용",
      title: "미리보기는 애플리케이션과 다른 출처에서 열립니다.",
      lead: "설치와 편집이 반영되면 미리보기가 갱신됩니다. 미리보기 도메인은 설치 때 정한 와일드카드 도메인입니다.",
      blocks: [
        { type: "steps", items: [
          { title: "미리보기 실행", text: "프로젝트를 연 뒤 미리보기 실행을 누릅니다. 선언된 패키지를 설치하고 개발 서버가 준비되면 미리보기가 열립니다. 실행 중에는 같은 자리가 미리보기 취소가 됩니다." },
          { title: "파일 변경을 반영합니다", text: "파일 트리에서 고친 로컬 초안은 미리보기에 반영됩니다. 개발 서버가 중지되면 미리보기는 새로고침되지 않고, 개발 서버를 다시 실행해야 현재 로컬 초안으로 복구됩니다." },
          { title: "출처가 나뉩니다", text: "미리보기 주소는 설치 때 정한 와일드카드 도메인입니다. 애플리케이션 도메인과 나뉩니다. 프로젝트 페이지가 미리보기 저장소를 그대로 읽지 않기 위해서입니다." }
        ] },
        { type: "callout", tone: "note", text: "운영 설치는 그 와일드카드의 DNS와 TLS가 역방향 프록시에서 준비된 뒤에만 미리보기를 엽니다. `NURITEO_PREVIEW_WILDCARD_READY=true` 는 운영자가 그 준비를 확인했다는 표시이고, NURITEO가 DNS를 대신 만들지 않습니다." },
        { type: "links", items: [{ to: "/install/compose", label: "Compose에서 도메인 정하기" }] }
      ]
    },
    en: {
      nav: "Preview",
      eyebrow: "Use",
      title: "Preview opens on a different origin from the application.",
      lead: "Preview updates as installs and edits land. The Preview domain is the wildcard domain chosen at install time.",
      blocks: [
        { type: "steps", items: [
          { title: "미리보기 실행", text: "Open a project and press 미리보기 실행. Preview opens after the declared packages install and the dev server is ready. While that run is in progress the same control becomes 미리보기 취소." },
          { title: "Pick up the file change", text: "A local draft from the file tree is applied to Preview. If the dev server has stopped, Preview does not refresh. Start the dev server again to recover Preview from the current local draft." },
          { title: "The origin stays separate", text: "The Preview address is the wildcard domain chosen at install time. It is separate from the application domain so the project page does not read Preview storage directly." }
        ] },
        { type: "callout", tone: "note", text: "A production install opens Preview only after DNS and TLS for that wildcard are ready at the reverse proxy. `NURITEO_PREVIEW_WILDCARD_READY=true` records that the operator checked that work. NURITEO does not create the DNS records." },
        { type: "links", items: [{ to: "/install/compose", label: "Choose the domain in Compose" }] }
      ]
    }
  },
  {
    path: "/use/files",
    group: { ko: "사용", en: "Use" },
    ko: {
      nav: "파일과 터미널",
      eyebrow: "사용",
      title: "파일 트리와 프로젝트 터미널을 씁니다.",
      lead: "파일 트리에서 읽고 씁니다. 프로젝트 터미널에서 선언된 패키지 매니저 명령을 실행합니다.",
      blocks: [
        { type: "h2", text: "파일" },
        { type: "p", text: "파일 트리에서 프로젝트 파일을 열고 고칩니다. 고친 표시가 있는 파일은 아직 서버에 저장되지 않은 로컬 초안입니다. 서버에 저장한 뒤에 프로젝트 파일로 남습니다." },
        { type: "h2", text: "터미널" },
        { type: "example", title: "선언된 의존성을 다시 설치합니다", text: "프로젝트 터미널은 그 프로젝트가 선언한 패키지 매니저 명령만 실행합니다. npm install과 yarn install도 같은 자리입니다. 임의의 셸 전체는 아닙니다.", code: "pnpm install", result: "터미널에 그 명령의 출력이 남고, 설치가 끝나면 프로세스가 종료됩니다. 브라우저 안의 Docker, 네이티브 애드온, 임의의 네이티브 바이너리는 이 터미널의 범위가 아닙니다." },
        { type: "h2", text: "Studio 키" },
        { type: "p", text: "Ctrl은 macOS에서 ⌘입니다. 터미널을 열고 닫는 키만 Ctrl+` 이고 ⌘로 바뀌지 않습니다." },
        { type: "table", columns: ["키", "동작"], rows: [
          ["Ctrl+S", "서버에 저장"],
          ["Ctrl+P", "파일 빠른 열기"],
          ["Ctrl+B", "사이드바"],
          ["Ctrl+J", "미리보기 패널"],
          ["Ctrl+\\", "편집기 분할"],
          ["Ctrl+`", "터미널 패널"],
          ["Ctrl+Shift+E", "파일 사이드바"],
          ["Ctrl+Shift+F", "파일 검색"]
        ] },
        { type: "p", text: "한계의 전체 목록은 지원 범위에 있습니다." },
        { type: "p", text: "관리자 화면에는 초대, 백업, 감사 로그, 레지스트리, 신원 공급자가 있습니다. 운영 절차는 설치와 보안 문서에 있습니다." },
        { type: "links", items: [
          { to: "/limits", label: "지원 범위" },
          { to: "/security", label: "보안" }
        ] }
      ]
    },
    en: {
      nav: "Files and the terminal",
      eyebrow: "Use",
      title: "Use the file tree and the project terminal.",
      lead: "Read and write from the file tree. Run the project's declared package-manager commands in the project terminal.",
      blocks: [
        { type: "h2", text: "Files" },
        { type: "p", text: "Open and edit project files from the file tree. A file marked as changed is still a local draft. It stays as a project file after 서버에 저장." },
        { type: "h2", text: "Terminal" },
        { type: "example", title: "Reinstall declared dependencies", text: "The project terminal runs only the package-manager commands that project declares. npm install and yarn install belong in the same place. It is not an arbitrary shell.", code: "pnpm install", result: "The terminal keeps that command's output, and the process exits when the install finishes. Docker in the browser, native addons, and arbitrary native binaries are outside that terminal." },
        { type: "h2", text: "Studio keys" },
        { type: "p", text: "Ctrl is ⌘ on macOS. The terminal key stays Ctrl+` and does not become ⌘." },
        { type: "table", columns: ["Key", "Action"], rows: [
          ["Ctrl+S", "서버에 저장"],
          ["Ctrl+P", "Quick open"],
          ["Ctrl+B", "Sidebar"],
          ["Ctrl+J", "Preview panel"],
          ["Ctrl+\\", "Split the editor"],
          ["Ctrl+`", "Terminal panel"],
          ["Ctrl+Shift+E", "File sidebar"],
          ["Ctrl+Shift+F", "Search files"]
        ] },
        { type: "p", text: "The full boundary is the supported scope." },
        { type: "p", text: "Administrator screens cover invites, backups, the audit log, registries, and identity providers. Operator procedure stays in the install and security pages." },
        { type: "links", items: [
          { to: "/limits", label: "Supported scope" },
          { to: "/security", label: "Security" }
        ] }
      ]
    }
  },
  {
    path: "/limits",
    group: { ko: "지원 범위", en: "Scope" },
    ko: {
      nav: "지원 범위",
      eyebrow: "지원 범위",
      title: "데스크톱 Chrome의 Vite 경로를 지원합니다.",
      lead: "이 페이지는 저장소의 알려진 제한과 같은 범위를 사용자 문장으로 다시 쓴 것입니다.",
      blocks: [
        { type: "h2", text: "지원하는 것" },
        { type: "p", text: "지원 경로는 하나입니다. 운영자가 자기 인프라에 Core를 올리고, 데스크톱 Chrome에서 Vite 프로젝트를 연 뒤, 그 프로젝트가 선언한 패키지를 설치하고, 파일을 고치고, 미리보기가 갱신되는 것입니다." },
        { type: "ul", items: [
          "셀프호스트 Core",
          "데스크톱 Chrome",
          "Vite 프로젝트를 열고, 선언된 패키지를 설치하고, 편집하고, 미리보기"
        ] },
        { type: "h2", text: "범위 밖" },
        { type: "ul", items: [
          "매니지드 클라우드, 결제, 라이선스 키, 전화 홈 활성화. 이 저장소의 제품은 셀프호스트입니다.",
          "임의의 npm 패키지 전체. 설치는 그 프로젝트가 선언한 의존성만 대상입니다.",
          "모바일 Safari. 지원하는 브라우저는 데스크톱 Chrome입니다.",
          "브라우저 안의 Docker. 프로젝트 터미널이 컨테이너를 띄우지 않습니다.",
          "직접 TCP 데이터베이스. 데이터베이스 포트에 직접 붙는 경로는 없습니다.",
          "네이티브 애드온. 노드 네이티브 애드온은 지원 경로에 없습니다.",
          "임의의 네이티브 바이너리. 선언된 패키지 매니저 명령 밖의 네이티브 실행 파일은 범위 밖입니다."
        ] },
        { type: "links", items: [{ to: `${repo}/docs/release/known-limitations.md`, label: "known-limitations.md" }] }
      ]
    },
    en: {
      nav: "Supported scope",
      eyebrow: "Scope",
      title: "Desktop Chrome and the Vite path are supported.",
      lead: "This page restates the repository's known limitations for people using the product.",
      blocks: [
        { type: "h2", text: "Supported" },
        { type: "p", text: "There is one supported path. An operator runs Core on their own infrastructure, then on desktop Chrome opens a Vite project, installs the packages that project declares, edits files, and watches Preview update." },
        { type: "ul", items: [
          "Self-hosted Core",
          "Desktop Chrome",
          "Open a Vite project, install its declared packages, edit, and preview"
        ] },
        { type: "h2", text: "Outside the path" },
        { type: "ul", items: [
          "Managed cloud, billing, license keys, and phone-home activation. This repository ships the self-hosted product.",
          "Arbitrary npm packages as a whole. Installation targets only dependencies the project declares.",
          "Mobile Safari. The supported browser is desktop Chrome.",
          "Docker in the browser. The project terminal does not start containers.",
          "Direct TCP databases. There is no path that opens a database port directly.",
          "Native addons. Node native addons are not on the supported path.",
          "Arbitrary native binaries. A native executable outside the declared package-manager commands is outside the path."
        ] },
        { type: "links", items: [{ to: `${repo}/docs/release/known-limitations.md`, label: "known-limitations.md" }] }
      ]
    }
  },
  {
    path: "/sdk",
    group: { ko: "SDK", en: "SDK" },
    playground: true,
    ko: {
      nav: "SDK 실행",
      eyebrow: "@nuriteo/sdk",
      title: "브라우저 페이지 안에 런타임을 붙입니다.",
      lead: "@nuriteo/sdk는 브라우저 페이지 안에 NURITEO 런타임을 붙이는 라이브러리입니다. 셀프호스트 서버가 아닙니다. 파일, 패키지, 미리보기, 프로젝트 동작은 호출하는 쪽이 어댑터를 연결합니다.",
      blocks: [
        { type: "ul", items: [
          "런타임 부팅, 상태와 메트릭, 종료",
          "파일 읽기·쓰기·디렉터리·삭제·변경 감지",
          "npm, pnpm, Yarn 설치와 스크립트·바이너리 실행",
          "작업 디렉터리와 환경 변수를 지정한 프로세스",
          "미리보기 포트, 서비스 워커, 워커와 WASM 주소",
          "프로젝트 묶음 내보내기와 가져오기",
          "createNuriteoWebContainer() 입구",
          "호출의 시작, 성공, 실패 추적"
        ] },
        { type: "p", text: "패키지에는 system_wasm.wasm, 시스템 워커, 프로세스 워커, Next·Vite·Yarn 실행 파일이 들어 있습니다. 실행에는 Cross-Origin-Embedder-Policy: require-corp 와 Cross-Origin-Opener-Policy: same-origin 이 필요합니다. 문서 개발 서버는 그 헤더를 직접 붙입니다. GitHub Pages는 헤더를 직접 붙이지 못하므로, 공개 사이트는 서비스 워커가 같은 헤더를 더하고 한 번 다시 연 뒤 이 브라우저에서 예시를 실행합니다. 격리가 되지 않으면 부팅 성공으로 표시하지 않습니다." },
        { type: "p", text: "아래는 이 페이지 안의 샌드박스입니다. sandbox.mjs의 note를 고치면 오른쪽 결과가 그 값으로 바뀝니다. createContainer와 runtime은 편집기 안에 이미 들어와 있습니다. 런타임 안의 임의 JavaScript 평가는 막혀 있으므로 container.run에 넣은 소스 문자열은 실행되지 않습니다. 기본 예시는 entrypoint fs-smoke로 /workspace/result.txt에 hello를 쓰고, 그 파일 크기는 5바이트로 남습니다. 다른 SDK 페이지의 예제는 어댑터가 필요한 호출이라 이 샌드박스에서 실행되지 않습니다. 복사해서 자기 페이지에 붙입니다." },
        { type: "playground" },
        { type: "links", items: [
          { to: "/sdk/install", label: "설치" },
          { to: "/sdk/container", label: "컨테이너" },
          { to: "/sdk/adapters", label: "어댑터" }
        ] }
      ]
    },
    en: {
      nav: "Run the SDK",
      eyebrow: "@nuriteo/sdk",
      title: "Attach the runtime to a browser page.",
      lead: "@nuriteo/sdk is the library that attaches the NURITEO runtime to a browser page. It is not the self-hosted server. Files, packages, Preview, and projects run through adapters the caller supplies.",
      blocks: [
        { type: "ul", items: [
          "Boot, status, metrics, and teardown",
          "File read, write, directories, delete, and watch",
          "npm, pnpm, and Yarn install, scripts, and binaries",
          "Processes with a working directory and environment",
          "Preview ports, the service worker, and worker and WASM URLs",
          "Project bundle export and import",
          "The createNuriteoWebContainer() entry",
          "Start, success, and failure traces"
        ] },
        { type: "p", text: "The package includes system_wasm.wasm, the system worker, the process worker, and the Next, Vite, and Yarn executables. Running needs Cross-Origin-Embedder-Policy: require-corp and Cross-Origin-Opener-Policy: same-origin. The docs dev server sends those headers itself. GitHub Pages cannot send them directly, so the public site adds the same headers from a service worker, reloads once, and then runs the sample in this browser. If isolation does not start, the page does not report a successful boot." },
        { type: "p", text: "The block below is a sandbox on this page. Change note in sandbox.mjs and the result on the right becomes that value. createContainer and runtime are already in scope in the editor. Arbitrary JavaScript evaluation inside the runtime is disabled, so a source string passed to container.run does not execute. The default sample uses the fs-smoke entrypoint, writes hello to /workspace/result.txt, and that file stays 5 bytes. Examples on the other SDK pages need adapters, so they do not run in this sandbox. Copy them into your own page." },
        { type: "playground" },
        { type: "links", items: [
          { to: "/sdk/install", label: "Install" },
          { to: "/sdk/container", label: "Container" },
          { to: "/sdk/adapters", label: "Adapters" }
        ] }
      ]
    }
  },
  {
    path: "/sdk/install",
    group: { ko: "SDK", en: "SDK" },
    ko: {
      nav: "SDK 설치",
      eyebrow: "SDK",
      title: "beta 태그로 설치합니다.",
      lead: "공개 버전은 0.1.0-beta.1이고 beta 태그가 그 버전을 가리킵니다. latest는 이름만 등록한 0.0.0이므로 태그 없이 설치하지 않습니다.",
      blocks: [
        { type: "example", title: "npm으로 설치합니다", text: "beta 태그가 0.1.0-beta.1을 가리킵니다. latest는 이름만 등록한 0.0.0이므로 태그 없이 설치하지 않습니다.", code: "npm install @nuriteo/sdk@beta", result: "설치가 끝나면 패키지에 ESM, CommonJS, 타입 선언이 있습니다. latest로 설치하면 이름만 있는 0.0.0이 옵니다." },
        { type: "example", title: "pnpm과 Yarn", text: "같은 beta 태그를 씁니다.", code: "pnpm add @nuriteo/sdk@beta\nyarn add @nuriteo/sdk@beta", result: "저장소 주소는 github.com/ByeongGi/nuriteo 입니다. 배포에는 npm 배포 증명과 SLSA provenance가 붙습니다. 증명은 빌드 출처이고 동작 보장은 아닙니다." },
        { type: "h2", text: "소비자 빌드" },
        { type: "ul", items: [
          "TypeScript moduleResolution Bundler로 루트 타입을 가져옵니다.",
          "CommonJS require로 createContainer, createPreviewRelay, protocolVersion을 봅니다.",
          "Vite, Webpack, Rspack, Next 앱이 루트 패키지를 빌드합니다.",
          "Webpack과 Rspack의 워커 주소는 location.href 기준입니다.",
          "Next는 transpilePackages와 클라이언트 컴포넌트를 씁니다."
        ] },
        { type: "p", text: "이 경계는 저장소의 pnpm test:sdk-consumer 입니다. 그 명령은 pnpm package:sdk 로 만든 로컬 tarball을 설치합니다. 레지스트리의 @beta 를 받아 설치하는 검사는 아직 없습니다." }
      ]
    },
    en: {
      nav: "Install the SDK",
      eyebrow: "SDK",
      title: "Install the beta tag.",
      lead: "The public version is 0.1.0-beta.1 and the beta tag points at it. latest is the name-only 0.0.0 package, so install with the tag.",
      blocks: [
        { type: "example", title: "Install with npm", text: "The beta tag points at 0.1.0-beta.1. latest is the name-only 0.0.0 package, so install with the tag.", code: "npm install @nuriteo/sdk@beta", result: "The installed package contains ESM, CommonJS, and type declarations. Installing latest fetches the name-only 0.0.0 package." },
        { type: "example", title: "pnpm and Yarn", text: "Use the same beta tag.", code: "pnpm add @nuriteo/sdk@beta\nyarn add @nuriteo/sdk@beta", result: "repository is github.com/ByeongGi/nuriteo. Publishes carry an npm publish attestation and SLSA provenance. Provenance records where the build came from. It is not a behavior guarantee." },
        { type: "h2", text: "Consumer builds" },
        { type: "ul", items: [
          "Import the root types with TypeScript moduleResolution Bundler.",
          "Read createContainer, createPreviewRelay, and protocolVersion from CommonJS require.",
          "Vite, Webpack, Rspack, and Next apps build the root package.",
          "Webpack and Rspack worker URLs are resolved from location.href.",
          "Next uses transpilePackages and a client component."
        ] },
        { type: "p", text: "That boundary is pnpm test:sdk-consumer in this repository. It installs the local tarball from pnpm package:sdk. There is no test yet that installs @beta from the registry." }
      ]
    }
  },
  {
    path: "/sdk/container",
    group: { ko: "SDK", en: "SDK" },
    ko: {
      nav: "컨테이너",
      eyebrow: "SDK",
      title: "createContainer()로 부팅하고 상태를 읽습니다.",
      lead: "Nuriteo 인스턴스의 boot, run, teardown, status, metrics, systemMetrics를 씁니다. 서비스 모음은 services에 있습니다.",
      blocks: [
        { type: "example", title: "샌드박스에서 fs-smoke를 실행합니다", text: "이 문서의 샌드박스 안에서는 runtime을 그대로 넘깁니다. 빈 소스와 entrypoint fs-smoke는 준비된 입구를 실행합니다. 소스 문자열은 JavaScript로 평가되지 않습니다.", code: "const container = createContainer(runtime);\nconst ready = await container.boot({ timeoutMs: 20_000 });\nconst run = await container.run(\"\", {\n  entrypoint: \"fs-smoke\",\n  timeoutMs: 20_000\n});\nreturn {\n  protocolVersion: ready.protocolVersion,\n  status: container.status,\n  ok: run.ok\n};", result: "boot이 끝나면 status는 ready입니다. run.ok가 참이면 fs-smoke가 /workspace/result.txt에 hello를 썼습니다. protocolVersion은 그 런타임의 프로토콜 번호입니다." },
        { type: "example", title: "페이지가 워커 주소를 직접 넘깁니다", text: "샌드박스 밖에서는 systemWorkerUrl, processWorkerUrl, systemWasmUrl을 옵션으로 둡니다. services는 어댑터를 넘길 때 같이 둡니다.", code: "const container = createContainer({\n  systemWorkerUrl,\n  processWorkerUrl,\n  systemWasmUrl\n});\nconst ready = await container.boot({ timeoutMs: 20_000 });\ncontainer.status;\ncontainer.metrics;\nawait container.systemMetrics();\nawait container.teardown();", result: "ready.protocolVersion으로 프로토콜을 확인합니다. teardown이 끝나면 워커는 멈춥니다. status는 stopped로 갑니다." },
        { type: "h2", text: "동적 로드" },
        { type: "p", text: "파일을 하나씩 쓰고, 공개한 주소에서 한 파일을 가져오고, 엔트리만 바꾸고, HTML의 script src를 따르고, 한 디렉터리만 올리고, 없는 경로를 읽습니다. loadContainerCase와 memoryFilesystem과 scriptSrcFromHtml은 이 페이지의 함수이고, /sdk 편집기는 이 함수들을 받지 않습니다. 이 과정은 패키지를 설치하거나 개발 서버를 시작하지 않습니다." },
        { type: "example", title: "SPA와 Next.js를 그때그때 불러 올립니다", text: "kind는 spa 또는 next입니다. loadContainerCase는 이 페이지의 동적 import이고 SDK 함수가 아닙니다. memoryFilesystem은 호출하는 페이지의 파일 맵입니다. 런타임 안의 임의 JavaScript 평가는 막혀 있습니다. 아래 코드는 /sdk 편집기에서 돌지 않습니다. 이 페이지의 첫 행이 같은 순서로 실행합니다.", code: mountCaseSource, result: "엔트리 파일을 다시 읽으면 SPA는 spa-ready, Next.js는 next-ready가 들어 있습니다. boot이 끝나면 status는 ready입니다. Next 케이스의 previewScript는 pnpm dev이고, 이 페이지는 그 스크립트를 실행하지 않습니다. SPA 케이스에는 개발 서버 스크립트가 없습니다." },
        ...loadExampleBlocks("ko"),
        { type: "cases" },
        { type: "h2", text: "메서드" },
        { type: "api", items: containerApi.ko }
      ]
    },
    en: {
      nav: "Container",
      eyebrow: "SDK",
      title: "Boot with createContainer() and read status.",
      lead: "A Nuriteo instance exposes boot, run, teardown, status, metrics, and systemMetrics. The service collection is services.",
      blocks: [
        { type: "example", title: "Run fs-smoke in the sandbox", text: "Inside this site's sandbox, pass runtime through. An empty source and the fs-smoke entrypoint run the prepared entry. The source string is not evaluated as JavaScript.", code: "const container = createContainer(runtime);\nconst ready = await container.boot({ timeoutMs: 20_000 });\nconst run = await container.run(\"\", {\n  entrypoint: \"fs-smoke\",\n  timeoutMs: 20_000\n});\nreturn {\n  protocolVersion: ready.protocolVersion,\n  status: container.status,\n  ok: run.ok\n};", result: "After boot, status is ready. When run.ok is true, fs-smoke has written hello to /workspace/result.txt. protocolVersion is that runtime's protocol number." },
        { type: "example", title: "Pass worker URLs from the page", text: "Outside the sandbox, pass systemWorkerUrl, processWorkerUrl, and systemWasmUrl. Pass services in the same options when you have adapters.", code: "const container = createContainer({\n  systemWorkerUrl,\n  processWorkerUrl,\n  systemWasmUrl\n});\nconst ready = await container.boot({ timeoutMs: 20_000 });\ncontainer.status;\ncontainer.metrics;\nawait container.systemMetrics();\nawait container.teardown();", result: "Read the protocol from ready.protocolVersion. After teardown the workers stop and status is stopped." },
        { type: "h2", text: "Dynamic load" },
        { type: "p", text: "Write one file at a time, fetch one published URL, replace the entry, follow an HTML script src, load one directory, and read a missing path. loadContainerCase, memoryFilesystem, and scriptSrcFromHtml belong to this page, and the /sdk editor does not receive them. This sequence does not install packages or start the dev server." },
        { type: "example", title: "Load an SPA or Next.js case when you need it", text: "kind is spa or next. loadContainerCase is this page's dynamic import, not an SDK function. memoryFilesystem is the caller's file map. Arbitrary JavaScript evaluation inside the runtime stays disabled. The sample below does not run in the /sdk editor. The first row on this page runs the same sequence.", code: mountCaseSource, result: "Reading the entry file back shows spa-ready for the SPA and next-ready for Next.js. After boot, status is ready. The Next case's previewScript is pnpm dev, and this page does not run that script. The SPA case has no dev-server script." },
        ...loadExampleBlocks("en"),
        { type: "cases" },
        { type: "h2", text: "Methods" },
        { type: "api", items: containerApi.en }
      ]
    }
  },
  {
    path: "/sdk/filesystem",
    group: { ko: "SDK", en: "SDK" },
    ko: {
      nav: "파일",
      eyebrow: "SDK",
      title: "services.fs로 파일을 다룹니다.",
      lead: "읽기, 쓰기, 디렉터리 나열, 만들기, 삭제, 감시를 제공합니다. 파일 어댑터가 없으면 호출은 SdkError ESDK_ADAPTER_MISSING으로 실패합니다.",
      blocks: [
        { type: "example", title: "메모리 맵에 hello를 쓰고 읽습니다", text: "샌드박스는 파일 어댑터를 붙이지 않습니다. 아래는 호출하는 페이지가 메모리 맵으로 최소 어댑터를 붙인 예입니다. 이 맵은 디렉터리와 감시를 만들지 않습니다.", code: "const files = new Map();\nconst container = createContainer({\n  ...runtime,\n  services: {\n    filesystem: {\n      async readFile(path) {\n        const value = files.get(path);\n        if (value === undefined) throw new Error(path);\n        return value;\n      },\n      async writeFile(path, data) {\n        files.set(path, data);\n      },\n      async readdir() {\n        return [...files.keys()].map((path) => ({ path, type: \"file\" }));\n      }\n    }\n  }\n});\nawait container.boot({ timeoutMs: 20_000 });\nawait container.services.fs.writeFile(\"/workspace/hello.txt\", \"hello\");\nconst text = await container.services.fs.readFile(\"/workspace/hello.txt\");\nawait container.teardown();\nreturn text;", result: "readFile이 돌려주는 값은 문자열 hello입니다. 어댑터가 없으면 services.fs 호출은 SdkError ESDK_ADAPTER_MISSING으로 실패합니다." },
        { type: "h2", text: "메서드" },
        { type: "api", items: filesystemApi.ko }
      ]
    },
    en: {
      nav: "Files",
      eyebrow: "SDK",
      title: "Use services.fs for files.",
      lead: "The API reads, writes, lists directories, creates them, deletes, and watches. Without a filesystem adapter the call fails with SdkError ESDK_ADAPTER_MISSING.",
      blocks: [
        { type: "example", title: "Write hello into a memory map and read it back", text: "The sandbox does not attach a filesystem adapter. The page below supplies the smallest adapter, a memory map. That map does not model directories or watch events.", code: "const files = new Map();\nconst container = createContainer({\n  ...runtime,\n  services: {\n    filesystem: {\n      async readFile(path) {\n        const value = files.get(path);\n        if (value === undefined) throw new Error(path);\n        return value;\n      },\n      async writeFile(path, data) {\n        files.set(path, data);\n      },\n      async readdir() {\n        return [...files.keys()].map((path) => ({ path, type: \"file\" }));\n      }\n    }\n  }\n});\nawait container.boot({ timeoutMs: 20_000 });\nawait container.services.fs.writeFile(\"/workspace/hello.txt\", \"hello\");\nconst text = await container.services.fs.readFile(\"/workspace/hello.txt\");\nawait container.teardown();\nreturn text;", result: "readFile returns the string hello. Without an adapter, a services.fs call fails with SdkError ESDK_ADAPTER_MISSING." },
        { type: "h2", text: "Methods" },
        { type: "api", items: filesystemApi.en }
      ]
    }
  },
  {
    path: "/sdk/packages",
    group: { ko: "SDK", en: "SDK" },
    ko: {
      nav: "패키지",
      eyebrow: "SDK",
      title: "services.packages로 선언된 패키지를 설치합니다.",
      lead: "매니저는 npm, pnpm, Yarn입니다. 스크립트와 바이너리 실행도 같은 API입니다. 패키지 매니저 어댑터가 없으면 호출은 실패합니다.",
      blocks: [
        { type: "example", title: "선언된 패키지를 설치하고 스크립트를 실행합니다", text: "제품의 미리보기 실행은 선언된 의존성을 설치한 뒤 개발 서버를 띄웁니다. SDK에서는 그 설치가 services.packages.install입니다. 어댑터가 명령을 실제로 수행합니다.", code: "const installed = await container.services.packages.install({\n  packageManager: \"pnpm\",\n  cwd: \"/workspace\"\n});\nconst started = await container.services.packages.run(\"dev\", {\n  cwd: \"/workspace\"\n});\nconst built = await container.services.packages.exec(\"vite\", {\n  args: [\"build\"],\n  cwd: \"/workspace\"\n});\nreturn [installed.exitCode, started.exitCode, built.exitCode];", result: "어댑터가 세 명령을 끝내면 각 exitCode가 배열로 돌아옵니다. 어댑터가 없으면 설치 호출이 실패하고 배열은 생기지 않습니다. 선언되지 않은 패키지 전체를 설치하는 경로는 지원 범위 밖입니다." },
        { type: "h2", text: "메서드" },
        { type: "api", items: packagesApi.ko }
      ]
    },
    en: {
      nav: "Packages",
      eyebrow: "SDK",
      title: "Install declared packages with services.packages.",
      lead: "The managers are npm, pnpm, and Yarn. Script and binary execution use the same API. Without a package-manager adapter the call fails.",
      blocks: [
        { type: "example", title: "Install declared packages and run a script", text: "In the product, 미리보기 실행 installs declared dependencies and then starts the dev server. In the SDK that install is services.packages.install. The adapter is what actually runs the command.", code: "const installed = await container.services.packages.install({\n  packageManager: \"pnpm\",\n  cwd: \"/workspace\"\n});\nconst started = await container.services.packages.run(\"dev\", {\n  cwd: \"/workspace\"\n});\nconst built = await container.services.packages.exec(\"vite\", {\n  args: [\"build\"],\n  cwd: \"/workspace\"\n});\nreturn [installed.exitCode, started.exitCode, built.exitCode];", result: "When the adapter finishes the three commands, the array is their exit codes. Without an adapter the install call fails and the array is never returned. Installing packages the project does not declare is outside the supported path." },
        { type: "h2", text: "Methods" },
        { type: "api", items: packagesApi.en }
      ]
    }
  },
  {
    path: "/sdk/processes",
    group: { ko: "SDK", en: "SDK" },
    ko: {
      nav: "프로세스",
      eyebrow: "SDK",
      title: "services.processes.spawn으로 명령을 실행합니다.",
      lead: "작업 디렉터리와 환경 변수를 지정합니다. 핸들은 입력을 쓰고, 크기를 바꾸고, 신호를 보내고, 종료를 기다립니다.",
      blocks: [
        { type: "example", title: "작업 디렉터리에서 pnpm install을 실행합니다", text: "프로젝트 터미널의 pnpm install과 같은 호출입니다. CI=1은 설치 명령이 질문을 멈추지 않게 할 때 붙입니다. 프로세스 어댑터가 없으면 spawn은 실패합니다.", code: "const handle = await container.services.processes.spawn({\n  command: \"pnpm\",\n  args: [\"install\"],\n  cwd: \"/workspace\",\n  env: { CI: \"1\" }\n});\nhandle.pid;\nconst result = await handle.wait();\nreturn result.exitCode;", result: "wait가 끝나면 exitCode가 돌아옵니다. pid는 그 핸들의 프로세스 번호입니다. stdout과 stderr는 result에 있습니다." },
        { type: "h2", text: "메서드" },
        { type: "api", items: processesApi.ko }
      ]
    },
    en: {
      nav: "Processes",
      eyebrow: "SDK",
      title: "Run a command with services.processes.spawn.",
      lead: "Set the working directory and environment. The handle writes input, resizes, signals, and waits for exit.",
      blocks: [
        { type: "example", title: "Run pnpm install in a working directory", text: "This is the same kind of call as pnpm install in the project terminal. CI=1 keeps an install from stopping on a prompt. spawn fails without a process adapter.", code: "const handle = await container.services.processes.spawn({\n  command: \"pnpm\",\n  args: [\"install\"],\n  cwd: \"/workspace\",\n  env: { CI: \"1\" }\n});\nhandle.pid;\nconst result = await handle.wait();\nreturn result.exitCode;", result: "wait returns the exitCode. pid on the handle identifies the process. stdout and stderr are on the result." },
        { type: "h2", text: "Methods" },
        { type: "api", items: processesApi.en }
      ]
    }
  },
  {
    path: "/sdk/preview",
    group: { ko: "SDK", en: "SDK" },
    ko: {
      nav: "미리보기와 워커",
      eyebrow: "SDK",
      title: "열린 포트와 워커 주소를 다룹니다.",
      lead: "services.preview는 열린 포트와 미리보기 이벤트를 냅니다. 서비스 워커가 없는 환경에서 등록하면 SdkError입니다.",
      blocks: [
        { type: "example", title: "워커 주소와 미리보기 스크립트", text: "resolveNuriteoWorkerAssets()가 돌려주는 필드는 systemWorkerUrl, processWorkerUrl, systemWasmUrl입니다. systemWasmUrl은 assets/system_wasm.wasm을 가리킵니다. 미리보기 서비스 워커 주소는 scriptUrl로 따로 넘깁니다.", code: "const assets = resolveNuriteoWorkerAssets(new URL(\"./\", import.meta.url));\nawait registerNuriteoPreviewServiceWorker({ scriptUrl: \"/preview-sw.js\" });\nawait container.services.preview.setPreviewScript(\"pnpm dev\");\nconst ports = await container.services.preview.ports();\nreturn { systemWorkerUrl: assets.systemWorkerUrl.href, ports };", result: "반환 객체의 systemWorkerUrl은 시스템 워커 주소이고, ports는 열린 포트 목록입니다. 서비스 워커가 없으면 ESDK_SERVICE_WORKER_UNAVAILABLE, 등록이 실패하면 ESDK_SERVICE_WORKER_REGISTRATION_FAILED입니다." },
        { type: "example", title: "열린 포트의 주소를 읽습니다", text: "개발 서버가 포트를 연 뒤에 ports()를 읽습니다. 서비스 메서드 이름은 ports입니다. server-ready 이벤트의 url도 같은 미리보기 주소입니다.", code: "await container.services.preview.setPreviewScript(\"pnpm dev\");\nconst stop = container.services.preview.subscribe((event) => {\n  if (event.type === \"server-ready\") event.url;\n});\nconst ports = await container.services.preview.ports();\nstop();\nreturn ports[0]?.url;", result: "서버가 포트를 연 뒤라면 첫 항목의 url이 미리보기 주소입니다. 포트를 열기 전에는 그 항목이 없습니다." },
        { type: "h2", text: "메서드" },
        { type: "api", items: previewApi.ko }
      ]
    },
    en: {
      nav: "Preview and workers",
      eyebrow: "SDK",
      title: "Read open ports and worker URLs.",
      lead: "services.preview reports open ports and Preview events. Registering a service worker where none exists throws SdkError.",
      blocks: [
        { type: "example", title: "Worker URLs and the Preview script", text: "resolveNuriteoWorkerAssets() returns systemWorkerUrl, processWorkerUrl, and systemWasmUrl. systemWasmUrl points at assets/system_wasm.wasm. Pass the preview service worker separately as scriptUrl.", code: "const assets = resolveNuriteoWorkerAssets(new URL(\"./\", import.meta.url));\nawait registerNuriteoPreviewServiceWorker({ scriptUrl: \"/preview-sw.js\" });\nawait container.services.preview.setPreviewScript(\"pnpm dev\");\nconst ports = await container.services.preview.ports();\nreturn { systemWorkerUrl: assets.systemWorkerUrl.href, ports };", result: "systemWorkerUrl on the returned object is the system worker URL, and ports is the list of open ports. A missing service worker throws ESDK_SERVICE_WORKER_UNAVAILABLE. A failed registration throws ESDK_SERVICE_WORKER_REGISTRATION_FAILED." },
        { type: "example", title: "Read the address of an open port", text: "Read ports() after the dev server opens a port. The service method is named ports. The url on a server-ready event is that same Preview address.", code: "await container.services.preview.setPreviewScript(\"pnpm dev\");\nconst stop = container.services.preview.subscribe((event) => {\n  if (event.type === \"server-ready\") event.url;\n});\nconst ports = await container.services.preview.ports();\nstop();\nreturn ports[0]?.url;", result: "Once the server has opened a port, the first item's url is the Preview address. Before that, the item is absent." },
        { type: "h2", text: "Methods" },
        { type: "api", items: previewApi.en }
      ]
    }
  },
  {
    path: "/sdk/projects",
    group: { ko: "SDK", en: "SDK" },
    ko: {
      nav: "프로젝트 묶음",
      eyebrow: "SDK",
      title: "services.projects로 묶음을 내보내고 가져옵니다.",
      lead: "프로젝트 어댑터가 묶음의 바이트를 만들고 다시 읽습니다. 어댑터가 없으면 호출은 실패합니다.",
      blocks: [
        { type: "example", title: "묶음을 내보내고 그대로 가져옵니다", text: "가져온 묶음으로 프로젝트를 시작하는 제품 경로와 같은 바이트입니다. export가 만든 값을 import에 그대로 넘깁니다.", code: "const archive = await container.services.projects.export();\nawait container.services.projects.import(archive);", result: "archive는 어댑터가 만든 묶음 바이트입니다. import는 그 바이트를 다시 읽습니다. 프로젝트 어댑터가 없으면 두 호출 모두 실패합니다. 샌드박스는 이 어댑터를 붙이지 않습니다." },
        { type: "h2", text: "메서드" },
        { type: "api", items: projectsApi.ko }
      ]
    },
    en: {
      nav: "Project bundles",
      eyebrow: "SDK",
      title: "Export and import a bundle with services.projects.",
      lead: "The project adapter produces the bundle bytes and reads them back. Without that adapter the call fails.",
      blocks: [
        { type: "example", title: "Export a bundle and import those bytes", text: "These are the same bytes as starting a project from an imported bundle. Pass the value from export straight to import.", code: "const archive = await container.services.projects.export();\nawait container.services.projects.import(archive);", result: "archive is the bundle bytes the adapter produced. import reads those bytes back. Both calls fail without a project adapter. The sandbox does not attach one." },
        { type: "h2", text: "Methods" },
        { type: "api", items: projectsApi.en }
      ]
    }
  },
  {
    path: "/sdk/webcontainer",
    group: { ko: "SDK", en: "SDK" },
    ko: {
      nav: "WebContainer형 입구",
      eyebrow: "SDK",
      title: "createNuriteoWebContainer()로 부팅, 파일, 명령을 한 객체에 둡니다.",
      lead: "COEP 기본값은 require-corp입니다. 미리보기 어댑터가 없어도 부팅은 진행되고, 미리보기 이벤트만 오지 않습니다.",
      blocks: [
        { type: "example", title: "최소 package.json을 마운트하고 설치합니다", text: "createNuriteoWebContainer()는 부팅, 파일, 명령을 한 객체에 둡니다. 이벤트 이름은 port, server-ready, server-close입니다. 스냅샷의 package.json은 프로젝트 이름만 있는 최소 파일입니다.", code: "const container = await createNuriteoWebContainer().boot();\nawait container.mount(createNuriteoMountSnapshot({\n  \"package.json\": \"{\\\"name\\\":\\\"demo\\\"}\"\n}));\nconst process = await container.spawn(\"pnpm\", [\"install\"]);\ncontainer.on(\"server-ready\", (event) => event.url);\nawait container.teardown();", result: "mount는 그 package.json만 올립니다. 의존성을 선언하지 않았으므로 pnpm install은 그 파일에 적힌 것만 설치합니다. 미리보기 어댑터가 없으면 boot은 끝나고 server-ready는 오지 않습니다." },
        { type: "h2", text: "메서드" },
        { type: "api", items: webcontainerApi.ko }
      ]
    },
    en: {
      nav: "WebContainer-shaped entry",
      eyebrow: "SDK",
      title: "Keep boot, files, and commands on createNuriteoWebContainer().",
      lead: "The default COEP mode is require-corp. Boot still proceeds without a Preview adapter. Preview events are the part that stays quiet.",
      blocks: [
        { type: "example", title: "Mount a minimal package.json and install", text: "createNuriteoWebContainer() keeps boot, files, and commands on one object. The event names are port, server-ready, and server-close. The snapshot's package.json is only a project name.", code: "const container = await createNuriteoWebContainer().boot();\nawait container.mount(createNuriteoMountSnapshot({\n  \"package.json\": \"{\\\"name\\\":\\\"demo\\\"}\"\n}));\nconst process = await container.spawn(\"pnpm\", [\"install\"]);\ncontainer.on(\"server-ready\", (event) => event.url);\nawait container.teardown();", result: "mount writes only that package.json. It declares no dependencies, so pnpm install installs only what that file lists. Without a Preview adapter, boot still finishes and server-ready does not fire." },
        { type: "h2", text: "Methods" },
        { type: "api", items: webcontainerApi.en }
      ]
    }
  },
  {
    path: "/sdk/adapters",
    group: { ko: "SDK", en: "SDK" },
    ko: {
      nav: "어댑터",
      eyebrow: "SDK",
      title: "없는 어댑터의 호출은 실패합니다.",
      lead: "NuriteoServices는 파일, 패키지, 미리보기, 프로젝트, 프로세스 어댑터를 옵션으로 받습니다. onTrace는 카테고리, 연산, 시작·성공·실패, 시각을 냅니다.",
      blocks: [
        { type: "ul", items: [
          "파일: readFile, writeFile, readdir, mkdir, rm, watch",
          "패키지: install, run, exec. packageManager는 npm, pnpm, yarn",
          "미리보기: listPorts, setPreviewScript, subscribe",
          "프로젝트: exportProject, importProject",
          "프로세스: spawn. 핸들은 kill, resize, write, wait"
        ] },
        { type: "p", text: "SdkError 코드는 ESDK_ADAPTER_MISSING, ESDK_INVALID_ARGUMENT, ESDK_LIFECYCLE_FAILED, ESDK_PATH_INVALID, ESDK_SERVICE_WORKER_UNAVAILABLE, ESDK_SERVICE_WORKER_REGISTRATION_FAILED, ESDK_SYMLINK_UNSUPPORTED입니다." },
        { type: "example", title: "파일 쓰기의 시작과 성공을 봅니다", text: "onTrace는 카테고리, 연산, phase, 시각을 냅니다. phase는 start, success, error입니다. 어댑터 메서드가 없으면 그 호출만 실패하고, 다른 서비스는 그대로입니다.", code: "const seen = [];\nconst services = new NuriteoServices({\n  filesystem: {\n    async readFile() { return \"\"; },\n    async writeFile() {},\n    async readdir() { return []; }\n  }\n});\nconst stop = services.onTrace((event) => {\n  if (event.operation === \"writeFile\") seen.push(event.phase);\n});\nawait services.fs.writeFile(\"/workspace/note.txt\", \"hello\");\nstop();\nreturn seen;", result: "성공한 쓰기는 start 다음에 success를 돌려줍니다. 호출이 실패하면 마지막 phase는 error이고 error 문자열이 붙으며, 그 호출만 거부됩니다." },
        { type: "h2", text: "오류" },
        { type: "api", items: errorApi.ko }
      ]
    },
    en: {
      nav: "Adapters",
      eyebrow: "SDK",
      title: "A call without its adapter fails.",
      lead: "NuriteoServices takes filesystem, package, Preview, project, and process adapters. onTrace reports the category, operation, start, success, or failure, and the time.",
      blocks: [
        { type: "ul", items: [
          "Files: readFile, writeFile, readdir, mkdir, rm, watch",
          "Packages: install, run, exec. packageManager is npm, pnpm, or yarn",
          "Preview: listPorts, setPreviewScript, subscribe",
          "Projects: exportProject, importProject",
          "Processes: spawn. The handle has kill, resize, write, and wait"
        ] },
        { type: "p", text: "SdkError codes are ESDK_ADAPTER_MISSING, ESDK_INVALID_ARGUMENT, ESDK_LIFECYCLE_FAILED, ESDK_PATH_INVALID, ESDK_SERVICE_WORKER_UNAVAILABLE, ESDK_SERVICE_WORKER_REGISTRATION_FAILED, and ESDK_SYMLINK_UNSUPPORTED." },
        { type: "example", title: "Watch a file write start and succeed", text: "onTrace reports the category, operation, phase, and time. phase is start, success, or error. A missing adapter method fails only that call. The other services stay as they are.", code: "const seen = [];\nconst services = new NuriteoServices({\n  filesystem: {\n    async readFile() { return \"\"; },\n    async writeFile() {},\n    async readdir() { return []; }\n  }\n});\nconst stop = services.onTrace((event) => {\n  if (event.operation === \"writeFile\") seen.push(event.phase);\n});\nawait services.fs.writeFile(\"/workspace/note.txt\", \"hello\");\nstop();\nreturn seen;", result: "A write that succeeds returns start, then success. When the call fails, the last phase is error, the event includes an error string, and only that call rejects." },
        { type: "h2", text: "Errors" },
        { type: "api", items: errorApi.en }
      ]
    }
  },
  {
    path: "/security",
    group: { ko: "보안", en: "Security" },
    ko: {
      nav: "보안",
      eyebrow: "보안",
      title: "취약점은 비공개로 보고합니다.",
      lead: "공개 이슈에 익스플로잇, 자격 증명, 비공개 프로젝트 데이터, 백업, 편집하지 않은 지원 묶음을 올리지 않습니다. 저장소의 비공개 취약점 보고를 씁니다.",
      blocks: [
        { type: "h2", text: "보고" },
        { type: "steps", items: [
          { title: "비공개 보고를 엽니다", text: "저장소 호스트의 Security, Report a vulnerability를 씁니다. 그 입구가 없으면 현재 릴리스 노트의 비공개 보안 연락을 관리자에게 먼저 묻고, 기술 세부 사항은 그 다음에 보냅니다." },
          { title: "영향과 재현을 적습니다", text: "영향 받은 NURITEO 버전과 이미지 다이제스트, 재현 절차, 보안 영향, 편집한 운영 식별자를 넣습니다." },
          { title: "비밀은 빼둡니다", text: "비밀번호, 토큰, 개인 키, 프로젝트 소스, 원본 백업, 개인정보는 넣지 않습니다. 공개 이슈에도 같은 자료를 올리지 않습니다." }
        ] },
        { type: "ul", items: [
          "Critical 확인은 72시간, High는 7일, Medium은 14일, Low는 30일입니다.",
          "이 시간은 작은 오픈 소스 프로젝트의 최선을 다한 목표입니다. 유료 지원 약속이 아닙니다.",
          "매니지드 클라우드는 범위 밖이라 이 시계 뒤에 호스티드 운영 조직은 없습니다."
        ] },
        { type: "p", text: "보고가 받아들여지면 Incident Commander가 조율을 맡습니다. 공개는 조정된 권고입니다. 영향 범위가 확인되고, 완화 방법이 문서화되고, 고친 산출물이 있을 때 GHSA 또는 같은 권고를 냅니다." },
        { type: "p", text: "지원 묶음은 자동으로 업로드되지 않습니다. 장애 보고에는 편집된 NURITEO 지원 묶음을 첨부합니다. 비밀번호, 토큰, 개인 키, 프로젝트 소스, 원본 백업, 개인정보는 넣지 않습니다." },
        { type: "links", items: [
          { to: `${repo}/SECURITY.md`, label: "SECURITY.md" },
          { to: `${repo}/docs/security/vulnerability-and-incident-response.md`, label: "취약점과 장애 대응" },
          { to: `${repo}/docs/release/incident-playbook.md`, label: "장애 플레이북" }
        ] }
      ]
    },
    en: {
      nav: "Security",
      eyebrow: "Security",
      title: "Report vulnerabilities in private.",
      lead: "Do not put exploit details, credentials, private project data, backups, or an unredacted support bundle in a public issue. Use the repository's private vulnerability reporting.",
      blocks: [
        { type: "h2", text: "Report" },
        { type: "steps", items: [
          { title: "Open a private report", text: "Use the repository host's Security, Report a vulnerability flow. If that entry is missing, ask a maintainer for the private security contact in the current release notes before sending technical details." },
          { title: "Include impact and reproduction", text: "Send the affected NURITEO version and image digest, reproduction steps, the security impact, and redacted operation identifiers." },
          { title: "Leave secrets out", text: "Do not include passwords, tokens, private keys, project source, raw backups, or personal data. Do not put those materials in a public issue either." }
        ] },
        { type: "ul", items: [
          "Critical acknowledgement is 72 hours, High is 7 days, Medium is 14 days, and Low is 30 days.",
          "These windows are best-effort targets for a small open-source project. They are not a paid support promise.",
          "Managed cloud is out of scope, so there is no hosted operations team behind this clock."
        ] },
        { type: "p", text: "Once a report is accepted, an Incident Commander owns coordination. Disclosure is a coordinated advisory. Publish a GHSA, or an equivalent advisory, after the affected range is confirmed, a mitigation is documented, and a fixed artifact is available." },
        { type: "p", text: "A support bundle is not uploaded automatically. Attach a redacted NURITEO support bundle to an incident report. Do not include passwords, tokens, private keys, project source, raw backups, or personal data." },
        { type: "links", items: [
          { to: `${repo}/SECURITY.md`, label: "SECURITY.md" },
          { to: `${repo}/docs/security/vulnerability-and-incident-response.md`, label: "Vulnerability and incident response" },
          { to: `${repo}/docs/release/incident-playbook.md`, label: "Incident playbook" }
        ] }
      ]
    }
  },
  {
    path: "/develop",
    group: { ko: "개발", en: "Develop" },
    ko: {
      nav: "개발 개요",
      eyebrow: "개발",
      title: "모노레포는 pnpm과 Cargo입니다.",
      lead: "제품 앱은 apps/web입니다. 문서 사이트는 apps/docs이고 제품 서버 없이 빌드됩니다. SDK 발행물은 packages/sdk에서 pnpm package:sdk로 만듭니다.",
      blocks: [
        { type: "p", text: "릴리스 게이트의 통과 판정이나 비공개 태스크 목록은 이 문서에 없습니다." },
        { type: "links", items: [
          { to: "/develop/repository", label: "저장소 지도" },
          { to: "/develop/local", label: "로컬 개발" },
          { to: "/develop/checks", label: "검사와 테스트" },
          { to: "/develop/sdk-release", label: "SDK 빌드와 배포" }
        ] }
      ]
    },
    en: {
      nav: "Develop",
      eyebrow: "Develop",
      title: "The monorepo uses pnpm and Cargo.",
      lead: "The product app is apps/web. This docs site is apps/docs and builds without the product server. The SDK artifact is produced from packages/sdk with pnpm package:sdk.",
      blocks: [
        { type: "p", text: "Release-gate verdicts and private task lists are not in these pages." },
        { type: "links", items: [
          { to: "/develop/repository", label: "Repository map" },
          { to: "/develop/local", label: "Local development" },
          { to: "/develop/checks", label: "Checks and tests" },
          { to: "/develop/sdk-release", label: "SDK build and publish" }
        ] }
      ]
    }
  },
  {
    path: "/develop/repository",
    group: { ko: "개발", en: "Develop" },
    ko: {
      nav: "저장소 지도",
      eyebrow: "개발",
      title: "경로마다 맡은 일이 다릅니다.",
      lead: "생성된 node_modules, target, dist, artifacts, .next, .pnpm-store, .local은 커밋하지 않습니다.",
      blocks: [
        { type: "table", columns: ["경로", "역할"], rows: [
          ["apps/web", "Next.js 스튜디오와 브라우저 BFF"],
          ["apps/docs", "공개 문서 SPA"],
          ["packages/sdk", "@nuriteo/sdk 입구"],
          ["packages/protocol", "브라우저와 워커 메시지"],
          ["packages/browser-host", "OPFS, 프로세스, 권한 호스트"],
          ["packages/node-runtime", "브라우저 안 Node 호환 런타임"],
          ["packages/preview", "HMR과 서비스 워커"],
          ["packages/workspace-runtime", "스튜디오 세션"],
          ["packages/workers", "시스템, 프로세스, CLI 워커. 다른 패키지가 직접 가져오지 않습니다."],
          ["packages/api-client", "Core 클라이언트"],
          ["crates/nuriteo-server", "Rust Core"],
          ["crates/system-core, crates/system-wasm", "WASM 시스템"],
          ["compat/", "런타임 계약"],
          ["deploy/", "Compose, 이미지, Helm"],
          ["release/", "릴리스 기록과 게이트"],
          ["docs/", "검사가 읽는 공개 운영 문서"]
        ] }
      ]
    },
    en: {
      nav: "Repository map",
      eyebrow: "Develop",
      title: "Each path has one job.",
      lead: "Generated node_modules, target, dist, artifacts, .next, .pnpm-store, and .local are not committed.",
      blocks: [
        { type: "table", columns: ["Path", "Role"], rows: [
          ["apps/web", "Next.js studio and the browser BFF"],
          ["apps/docs", "Public docs SPA"],
          ["packages/sdk", "@nuriteo/sdk entry"],
          ["packages/protocol", "Browser and worker messages"],
          ["packages/browser-host", "OPFS, process, and permission host"],
          ["packages/node-runtime", "Node-compatible runtime in the browser"],
          ["packages/preview", "HMR and the service worker"],
          ["packages/workspace-runtime", "Studio session"],
          ["packages/workers", "System, process, and CLI workers. Other packages do not import them directly."],
          ["packages/api-client", "Core client"],
          ["crates/nuriteo-server", "Rust Core"],
          ["crates/system-core, crates/system-wasm", "WASM system"],
          ["compat/", "Runtime contracts"],
          ["deploy/", "Compose, images, and Helm"],
          ["release/", "Release records and gates"],
          ["docs/", "Public operator documents the checks read"]
        ] }
      ]
    }
  },
  {
    path: "/develop/local",
    group: { ko: "개발", en: "Develop" },
    ko: {
      nav: "로컬 개발",
      eyebrow: "개발",
      title: "pnpm dev가 개발 루프를 재시작합니다.",
      lead: "띄우는 명령은 소스 실행과 같습니다. 이 페이지는 코드 변경이 무엇을 다시 시작하는지 적습니다.",
      blocks: [
        { type: "example", title: "무엇을 다시 시작하는지", text: "Rust 소스 변경은 Core를 다시 빌드하고 재시작합니다. Web 변경은 Next.js HMR로 저장 즉시 갱신됩니다. Web만 다시 띄울 때는 pnpm dev:web을 씁니다.", code: "pnpm dev\npnpm dev:web\npnpm dev:stack:down\npnpm dev:stack:reset", result: "pnpm dev:stack:down은 데이터 스택을 멈추고 데이터를 남깁니다. 데이터와 인증정보를 지우는 명령은 pnpm dev:stack:reset뿐입니다." },
        { type: "p", text: "브라우저에서 확인할 경로는 제품과 같습니다. 데스크톱 Chrome에서 Vite 프로젝트를 열고, 설치하고, 편집하고, 미리보기가 남는지 봅니다." },
        { type: "links", items: [{ to: "/install/source", label: "소스에서 실행" }] }
      ]
    },
    en: {
      nav: "Local development",
      eyebrow: "Develop",
      title: "pnpm dev restarts the development loop.",
      lead: "The commands match the source install. This page says which code change restarts which part.",
      blocks: [
        { type: "example", title: "What restarts", text: "A Rust source change rebuilds and restarts Core. A Web change refreshes through Next.js HMR. Use pnpm dev:web to start Web alone.", code: "pnpm dev\npnpm dev:web\npnpm dev:stack:down\npnpm dev:stack:reset", result: "pnpm dev:stack:down stops the data stack and keeps the data. pnpm dev:stack:reset is the only command here that deletes data and credentials." },
        { type: "p", text: "The browser check matches the product. On desktop Chrome, open a Vite project, install, edit, and see that Preview remains." },
        { type: "links", items: [{ to: "/install/source", label: "Run from source" }] }
      ]
    }
  },
  {
    path: "/develop/checks",
    group: { ko: "개발", en: "Develop" },
    ko: {
      nav: "검사와 테스트",
      eyebrow: "개발",
      title: "자주 쓰는 검사부터 돌립니다.",
      lead: "CI의 빠른 검사는 워크스페이스, 개발 스택, 셀프호스트 베이스라인, 타입, 테스트입니다. 기획 문서가 빠져 건너뛰는 릴리스 검사는 여기에 나열하지 않습니다.",
      blocks: [
        { type: "example", title: "자주 도는 명령", text: "위에서부터 워크스페이스, 타입, Web, 세션 런타임, Rust 테스트입니다. pnpm test:sdk-consumer는 pnpm package:sdk 다음에 돌립니다. 문서 사이트만 볼 때는 마지막 두 명령입니다.", code: "pnpm check:workspace\npnpm check:types\npnpm test:web\npnpm test:workspace-runtime\ncargo test --workspace\npnpm package:sdk\npnpm test:sdk-consumer\npnpm --filter @nuriteo/docs test\npnpm --filter @nuriteo/docs typecheck", result: "각 명령은 실패하면 0이 아닌 종료 코드로 끝납니다. 기획 문서가 빠져 건너뛰는 릴리스 검사는 이 목록에 없습니다." },
      ]
    },
    en: {
      nav: "Checks and tests",
      eyebrow: "Develop",
      title: "Start with the checks people run often.",
      lead: "Fast CI runs the workspace check, the dev stack, the self-hosted baseline, types, and tests. Release checks that skip missing planning documents are not listed here.",
      blocks: [
        { type: "example", title: "Commands people run often", text: "From the top: workspace, types, Web, the session runtime, then the Rust tests. Run pnpm test:sdk-consumer after pnpm package:sdk. The last two commands check this docs site alone.", code: "pnpm check:workspace\npnpm check:types\npnpm test:web\npnpm test:workspace-runtime\ncargo test --workspace\npnpm package:sdk\npnpm test:sdk-consumer\npnpm --filter @nuriteo/docs test\npnpm --filter @nuriteo/docs typecheck", result: "A failed command exits with a non-zero status. Release checks that skip missing planning documents are not in this list." },
      ]
    }
  },
  {
    path: "/develop/sdk-release",
    group: { ko: "개발", en: "Develop" },
    ko: {
      nav: "SDK 배포",
      eyebrow: "개발",
      title: "SDK는 main에서 Publish SDK를 수동 실행할 때 npm에 올라갑니다.",
      lead: "pnpm package:sdk는 WASM을 빌드하고 dist/sdk/package와 tarball을 만듭니다. dist/는 git에 들어가지 않습니다.",
      blocks: [
        { type: "ul", items: [
          "GitHub OIDC로 배포합니다. 저장소 시크릿에 npm 토큰을 두지 않습니다.",
          "태그는 beta입니다.",
          "첫 배포 뒤 npm이 패키지를 검사하는 동안에는 같은 버전을 다시 올리지 않습니다."
        ] },
        { type: "p", text: "Trusted Publisher는 npm 조직 nuriteo의 @nuriteo/sdk에 연결됩니다. GitHub 저장소 주인은 ByeongGi, 저장소 이름은 nuriteo, workflow 파일은 publish-sdk.yml입니다." }
      ]
    },
    en: {
      nav: "SDK release",
      eyebrow: "Develop",
      title: "The SDK reaches npm when Publish SDK is run by hand on main.",
      lead: "pnpm package:sdk builds WASM and writes dist/sdk/package and the tarball. dist/ is not committed.",
      blocks: [
        { type: "ul", items: [
          "Publish uses GitHub OIDC. The repository does not store an npm token secret.",
          "The tag is beta.",
          "While npm is still scanning a first publish, do not publish that same version again."
        ] },
        { type: "p", text: "The trusted publisher is attached to @nuriteo/sdk in the npm org nuriteo. The GitHub repository owner is ByeongGi, the repository name is nuriteo, and the workflow file is publish-sdk.yml." }
      ]
    }
  }
];
