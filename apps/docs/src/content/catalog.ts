import type { DocEntry } from "./types.ts";

const repo = "https://github.com/ByeongGi/nuriteo/blob/main";

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
        { type: "links", items: [
          { to: "/install", label: "인스턴스 설치" },
          { to: "/use", label: "브라우저에서 사용" },
          { to: "/sdk", label: "@nuriteo/sdk로 런타임 붙이기" }
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
        { type: "links", items: [
          { to: "/install", label: "Install an instance" },
          { to: "/use", label: "Use it in the browser" },
          { to: "/sdk", label: "Embed the runtime with @nuriteo/sdk" }
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
        { type: "ul", items: [
          "소스를 고치며 실행하려면 소스 실행을 씁니다.",
          "한 대에서 제품과 같은 경계로 실행하려면 Compose를 씁니다.",
          "Kubernetes에는 Helm 차트를 씁니다."
        ] },
        { type: "p", text: "Node.js 24.17 이상 25 미만, pnpm 11.15 이상 12 미만, Rust 1.97은 소스 실행에만 해당합니다." },
        { type: "links", items: [
          { to: "/install/source", label: "소스에서 실행" },
          { to: "/install/compose", label: "단일 호스트 Compose" },
          { to: "/install/kubernetes", label: "Helm" },
          { to: "/install/admin", label: "첫 관리자" }
        ] }
      ]
    },
    en: {
      nav: "Install",
      eyebrow: "Install",
      title: "Choose where the instance runs.",
      lead: "An operator runs Web and Core on their own infrastructure. The shared pieces are Web, Core, PostgreSQL, and object storage. Object storage is RustFS or S3-compatible storage. Only Web is opened in the browser. Save and Preview traffic stay on the application origin.",
      blocks: [
        { type: "ul", items: [
          "Use the source path while changing the repository.",
          "Use Compose for the product boundary on one host.",
          "Use the Helm chart on Kubernetes."
        ] },
        { type: "p", text: "Node.js 24.17 up to but not including 25, pnpm 11.15 up to but not including 12, and Rust 1.97 apply only to the source path." },
        { type: "links", items: [
          { to: "/install/source", label: "Run from source" },
          { to: "/install/compose", label: "Single-host Compose" },
          { to: "/install/kubernetes", label: "Helm" },
          { to: "/install/admin", label: "First administrator" }
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
        { type: "code", text: "git clone https://github.com/ByeongGi/nuriteo.git\ncd nuriteo\npnpm install\npnpm dev" },
        { type: "p", text: "Node.js 24.17 이상 25 미만, pnpm 11.15 이상 12 미만, Rust 1.97이 필요합니다. PostgreSQL과 RustFS는 컨테이너로 남습니다. Core는 Rust 소스가 바뀌면 다시 빌드되고 재시작됩니다. Web은 http://127.0.0.1:3000 에서 Next.js HMR로 갱신됩니다. Ctrl-C는 Core와 Web만 멈추고 데이터 컨테이너는 남깁니다." },
        { type: "ul", items: [
          "pnpm dev:backend 는 Core와 데이터 스택입니다.",
          "pnpm dev:web 은 Web만 띄웁니다. pnpm dev:fe 는 같은 명령입니다.",
          "pnpm dev:stack, dev:stack:status, dev:stack:credentials, dev:stack:down, dev:stack:reset 으로 데이터 스택을 다룹니다."
        ] },
        { type: "p", text: "개발 자격과 TLS는 .local/nuriteo-compose 에 생깁니다. 이 값은 로컬 전용입니다. dev:stack:down 은 데이터를 남기고, dev:stack:reset 만 데이터와 인증정보를 지웁니다." }
      ]
    },
    en: {
      nav: "Run from source",
      eyebrow: "Install",
      title: "Clone the repository and start the dev server.",
      lead: "This path is for contributors and operators who run the source directly. Image installs are Compose and Helm.",
      blocks: [
        { type: "code", text: "git clone https://github.com/ByeongGi/nuriteo.git\ncd nuriteo\npnpm install\npnpm dev" },
        { type: "p", text: "Node.js 24.17 up to but not including 25, pnpm 11.15 up to but not including 12, and Rust 1.97 are required. PostgreSQL and RustFS stay in containers. Core rebuilds and restarts when Rust sources change. Web refreshes through Next.js HMR at http://127.0.0.1:3000. Ctrl-C stops Core and Web and leaves the data containers running." },
        { type: "ul", items: [
          "pnpm dev:backend runs Core and the data stack.",
          "pnpm dev:web runs Web only. pnpm dev:fe is the same command.",
          "pnpm dev:stack, dev:stack:status, dev:stack:credentials, dev:stack:down, and dev:stack:reset operate the data stack."
        ] },
        { type: "p", text: "Development credentials and TLS are written under .local/nuriteo-compose. Those values are local only. dev:stack:down keeps data. dev:stack:reset deletes data and credentials." }
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
        { type: "p", text: "저장소 루트에서 아래 파일 변수를 절대 경로로 둔 뒤 스택을 올립니다. Compose 파일에는 자격 증명 기본값이 없습니다. 비밀번호, TLS, 미리보기 서명 키, 통합 자격 마스터 키의 값 자체는 문서에 적지 않습니다." },
        { type: "code", text: "docker compose -f deploy/compose/compose.yaml up" },
        { type: "p", text: "시작 순서는 PostgreSQL과 RustFS가 준비된 뒤 버킷 준비와 앞으로만 가는 마이그레이션, 첫 관리자 생성, Core, Web입니다. 앞 단계가 실패하면 Core와 Web은 뜨지 않습니다. 공식 수용 경계는 Linux의 Docker Compose v2입니다." },
        { type: "h2", text: "필요한 파일" },
        { type: "ul", items: [
          "NURITEO_POSTGRES_PASSWORD_FILE, NURITEO_POSTGRES_SERVER_CERT_FILE, NURITEO_POSTGRES_SERVER_KEY_FILE",
          "NURITEO_DATABASE_URL_FILE, NURITEO_DATABASE_CA_FILE",
          "NURITEO_RUSTFS_ACCESS_KEY_FILE, NURITEO_RUSTFS_SECRET_KEY_FILE, NURITEO_RUSTFS_CA_FILE, NURITEO_RUSTFS_TLS_DIR",
          "NURITEO_BOOTSTRAP_ADMIN_EMAIL, NURITEO_BOOTSTRAP_ADMIN_NAME, NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE",
          "NURITEO_EXTERNAL_URL, NURITEO_PREVIEW_BASE_DOMAIN",
          "NURITEO_PREVIEW_SIGNING_KEY_FILE, NURITEO_MASTER_KEY_FILE, NURITEO_MASTER_KEY_VERSION"
        ] },
        { type: "p", text: "데이터는 compose down 뒤에도 볼륨에 남습니다. 데이터를 지울 때만 compose down --volumes 를 씁니다. Web 기본 바인드는 127.0.0.1 의 3000번 포트입니다." },
        { type: "h2", text: "외부 S3" },
        { type: "p", text: "브라우저가 버킷에 직접 붙지 않습니다. 묶인 버킷의 CORS 정리와 외부 버킷의 CORS 계약을 섞어 쓰지 않습니다. 외부 버킷은 미리 있어야 하고, 아래 검사는 읽기 전용입니다." },
        { type: "code", text: "docker compose -f deploy/compose/compose.external-s3.yaml run --rm storage-check" },
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
        { type: "p", text: "From the repository root, point the file variables below at absolute paths, then start the stack. The Compose file has no credential defaults. This page does not show passwords, TLS material, the Preview signing key, or the integration master key." },
        { type: "code", text: "docker compose -f deploy/compose/compose.yaml up" },
        { type: "p", text: "Startup waits until PostgreSQL and RustFS are ready, then prepares the bucket, applies forward-only migrations, creates the first administrator, and starts Core and then Web. A failed earlier step keeps Core and Web down. Official acceptance is Docker Compose v2 on Linux." },
        { type: "h2", text: "Required files" },
        { type: "ul", items: [
          "NURITEO_POSTGRES_PASSWORD_FILE, NURITEO_POSTGRES_SERVER_CERT_FILE, NURITEO_POSTGRES_SERVER_KEY_FILE",
          "NURITEO_DATABASE_URL_FILE, NURITEO_DATABASE_CA_FILE",
          "NURITEO_RUSTFS_ACCESS_KEY_FILE, NURITEO_RUSTFS_SECRET_KEY_FILE, NURITEO_RUSTFS_CA_FILE, NURITEO_RUSTFS_TLS_DIR",
          "NURITEO_BOOTSTRAP_ADMIN_EMAIL, NURITEO_BOOTSTRAP_ADMIN_NAME, NURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE",
          "NURITEO_EXTERNAL_URL, NURITEO_PREVIEW_BASE_DOMAIN",
          "NURITEO_PREVIEW_SIGNING_KEY_FILE, NURITEO_MASTER_KEY_FILE, NURITEO_MASTER_KEY_VERSION"
        ] },
        { type: "p", text: "Data remains in volumes after compose down. Use compose down --volumes only when the data should go away. Web binds 127.0.0.1 port 3000 by default." },
        { type: "h2", text: "External S3" },
        { type: "p", text: "The browser does not talk to the bucket directly. Do not mix the bundled bucket CORS cleanup with the external bucket CORS contract. The external bucket must already exist. The check below is read-only." },
        { type: "code", text: "docker compose -f deploy/compose/compose.external-s3.yaml run --rm storage-check" },
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
        { type: "p", text: "비공개 values 파일에는 시크릿 값을 넣지 않습니다. 이미 있는 Secret의 이름과 키만 가리킵니다. 이미지 참조는 sha256 다이제스트이고, 바뀌는 태그는 쓰지 않습니다." },
        { type: "code", text: "helm upgrade --install nuriteo deploy/charts/nuriteo \\\n  --namespace nuriteo \\\n  --create-namespace \\\n  -f values.yaml" },
        { type: "ul", items: [
          "postgresql.existingSecret: 데이터베이스 URL과 선택적인 CA",
          "objectStorage.existingSecret: S3 자격",
          "applicationSecrets.existingSecret: 마스터 키, 저장 멱등 키, 미리보기 서명 키",
          "bootstrapAdmin.existingSecret: 첫 관리자 비밀번호. bootstrap을 켤 때만"
        ] },
        { type: "p", text: "차트는 저장소 검사 또는 업그레이드 사전 검사, 앞으로만 가는 마이그레이션, 선택적인 첫 관리자 작업을 순서대로 돌린 다음 Web과 Core를 만듭니다. 훅이 실패하면 새 Deployment가 적용되기 전에 Helm이 멈추고, 이전 릴리스가 남습니다. 애플리케이션 주소는 HTTPS 출처의 / 이고, 하위 경로 배포는 지원하지 않습니다." }
      ]
    },
    en: {
      nav: "Helm",
      eyebrow: "Install",
      title: "Deploy Web and Core as one Helm release.",
      lead: "The chart is deploy/charts/nuriteo. Kubernetes 1.29 or newer is required. PostgreSQL stays outside the chart. Production storage is external HTTPS S3-compatible storage.",
      blocks: [
        { type: "p", text: "Keep secret values out of the private values file. Point it at an existing Secret by name and key. Image references are sha256 digests. Mutable tags are not used." },
        { type: "code", text: "helm upgrade --install nuriteo deploy/charts/nuriteo \\\n  --namespace nuriteo \\\n  --create-namespace \\\n  -f values.yaml" },
        { type: "ul", items: [
          "postgresql.existingSecret: database URL and optional CA",
          "objectStorage.existingSecret: S3 credentials",
          "applicationSecrets.existingSecret: master key, save idempotency key, and Preview signing key",
          "bootstrapAdmin.existingSecret: first administrator password, only when bootstrap is enabled"
        ] },
        { type: "p", text: "The chart runs a storage check or upgrade preflight, forward-only migration, and the optional first-administrator job, then creates Web and Core. A failed hook stops Helm before the new Deployments are applied and leaves the previous release in place. The application origin is an HTTPS origin at /. Subpath deployment is not supported." }
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
        { type: "p", text: "Compose는 환경 이름으로, Helm은 bootstrapAdmin.existingSecret으로 같은 세 값을 받습니다. 비밀번호 파일의 내용은 문서에 적지 않습니다." },
        { type: "code", text: "NURITEO_BOOTSTRAP_ADMIN_EMAIL\nNURITEO_BOOTSTRAP_ADMIN_NAME\nNURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE" },
        { type: "ul", items: [
          "스택을 올리면 bootstrap이 관리자 한 명을 만듭니다. 이미 만들어진 뒤의 재시작은 비밀번호를 다시 쓰지 않습니다.",
          "Web 출처를 열고 그 계정으로 서명합니다. 서명 폼은 POST이고, 비밀번호는 URL에 실리지 않습니다.",
          "다음 사람은 관리자 초대로 들어옵니다. 공개 가입 페이지는 없습니다."
        ] }
      ]
    },
    en: {
      nav: "First administrator",
      eyebrow: "Install",
      title: "Create one instance administrator, then invite people.",
      lead: "An install needs one instance administrator. Compose and Helm both take an email, a display name, and a password file through bootstrap.",
      blocks: [
        { type: "p", text: "Compose reads these names from the environment. Helm reads the password from bootstrapAdmin.existingSecret. The password file contents are not written on this page." },
        { type: "code", text: "NURITEO_BOOTSTRAP_ADMIN_EMAIL\nNURITEO_BOOTSTRAP_ADMIN_NAME\nNURITEO_BOOTSTRAP_ADMIN_PASSWORD_FILE" },
        { type: "ul", items: [
          "Starting the stack makes bootstrap create one administrator. A later restart does not rewrite that password.",
          "Open the Web origin and sign in with that account. The sign-in form is POST, and the password is not placed in the URL.",
          "The next person enters by an administrator invite. There is no public signup page."
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
        { type: "p", text: "릴리스 계획을 만든 뒤, 저장소 루트에서 업그레이드 도우미를 실행합니다. 도우미는 읽기 전용 사전 검사, 객체 저장소 확인, 앞으로만 가는 마이그레이션, Core 교체, Web 교체 순서입니다. 마이그레이션 전에 실패하면 워크로드는 바뀌지 않습니다." },
        { type: "code", text: "node deploy/compose/upgrade.mjs upgrade /absolute/path/to/upgrade-plan.json\nnode deploy/compose/upgrade.mjs rollback /absolute/path/to/upgrade-plan.json" },
        { type: "p", text: "롤백은 이전 Core와 Web으로만 되돌립니다. 다운 마이그레이션은 없습니다. 스키마나 객체를 되돌려야 하면 복원입니다. SDK 배포 채널을 되돌리는 것과 인스턴스 데이터베이스를 되돌리는 것은 다른 일입니다. 채널 포인터만 바뀌고, 이미 설치된 데이터베이스는 다시 쓰이지 않습니다." }
      ]
    },
    en: {
      nav: "Upgrade",
      eyebrow: "Install",
      title: "Database changes only move forward.",
      lead: "Rollback restores the previous Core and Web images. It does not downgrade the schema. Restoring schema or objects is a restore.",
      blocks: [
        { type: "p", text: "After you write a release plan, run the upgrade helper from the repository root. It runs a read-only preflight, an object-storage check, forward-only migration, Core replacement, then Web replacement. A failure before migration leaves the workloads unchanged." },
        { type: "code", text: "node deploy/compose/upgrade.mjs upgrade /absolute/path/to/upgrade-plan.json\nnode deploy/compose/upgrade.mjs rollback /absolute/path/to/upgrade-plan.json" },
        { type: "p", text: "Rollback returns only to the previous Core and Web. There is no down migration. Restoring schema or objects is a restore. Moving an SDK release channel and moving an instance database are different. The channel pointer changes. An installed database is not rewritten." }
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
        { type: "p", text: "되는 경로는 데스크톱 Chrome에서 다음 순서입니다. 매니지드 클라우드나 임의의 npm 전체는 이 경로에 없습니다." },
        { type: "ul", items: [
          "Web 출처에 서명합니다. 공개 가입은 없고, 계정은 첫 관리자 또는 관리자 초대입니다.",
          "워크스페이스에서 Vite 프로젝트를 만들거나 엽니다.",
          "그 프로젝트가 선언한 패키지를 설치합니다.",
          "파일을 고치고 저장합니다. 미리보기가 갱신되고, 저장한 결과는 남습니다."
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
        { type: "p", text: "The path that works on desktop Chrome is the sequence below. Managed cloud and arbitrary npm as a whole are not part of it." },
        { type: "ul", items: [
          "Sign in on the Web origin. There is no public signup. The account is the first administrator or an administrator invite.",
          "Create or open a Vite project from the workspace.",
          "Install the packages that project declares.",
          "Edit a file and save it. Preview updates, and the saved result remains."
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
        { type: "ul", items: [
          "워크스페이스에서 새 프로젝트를 만들거나, 이미 있는 프로젝트를 엽니다. 시작점은 템플릿 또는 가져온 묶음입니다.",
          "편집기에서 파일을 고치고 저장합니다. 저장한 내용이 프로젝트 파일로 남습니다.",
          "패키지 설치는 그 프로젝트가 선언한 의존성만 대상으로 합니다. 선언되지 않은 패키지를 임의로 받는 경로는 지원 범위 밖입니다."
        ] },
        { type: "links", items: [{ to: "/limits", label: "지원 범위" }] }
      ]
    },
    en: {
      nav: "Projects",
      eyebrow: "Use",
      title: "A saved edit stays in the project file.",
      lead: "Create or open a project. You can start from a template or an imported bundle.",
      blocks: [
        { type: "ul", items: [
          "Create a project from the workspace, or open one that already exists. The starting point is a template or an imported bundle.",
          "Edit a file in the editor and save it. The saved content stays as a project file.",
          "Package installation targets only the dependencies that project declares. Installing packages it does not declare is outside the supported path."
        ] },
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
        { type: "ul", items: [
          "프로젝트를 연 뒤 미리보기를 실행합니다. 선언된 패키지 설치와 파일 저장이 반영되면 미리보기가 갱신되고, 그 결과는 남습니다.",
          "미리보기 주소는 설치 때 정한 와일드카드 도메인입니다. 애플리케이션 도메인과 나뉩니다. 프로젝트 페이지가 미리보기 저장소를 그대로 읽지 않기 위해서입니다.",
          "운영 설치는 그 와일드카드의 DNS와 TLS가 역방향 프록시에서 준비된 뒤에만 미리보기를 엽니다. NURITEO_PREVIEW_WILDCARD_READY=true 는 운영자가 그 준비를 확인했다는 표시이고, NURITEO가 DNS를 대신 만들지 않습니다."
        ] },
        { type: "links", items: [{ to: "/install/compose", label: "Compose에서 도메인 정하기" }] }
      ]
    },
    en: {
      nav: "Preview",
      eyebrow: "Use",
      title: "Preview opens on a different origin from the application.",
      lead: "Preview updates as installs and edits land. The Preview domain is the wildcard domain chosen at install time.",
      blocks: [
        { type: "ul", items: [
          "Open a project and run Preview. After a declared-package install or a saved edit, Preview updates and the result remains.",
          "The Preview address is the wildcard domain chosen at install time. It is separate from the application domain so the project page does not read Preview storage directly.",
          "A production install opens Preview only after DNS and TLS for that wildcard are ready at the reverse proxy. NURITEO_PREVIEW_WILDCARD_READY=true records that the operator checked that work. NURITEO does not create the DNS records."
        ] },
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
        { type: "ul", items: [
          "파일 트리에서 프로젝트 파일을 열고, 고치고, 저장합니다.",
          "프로젝트 터미널은 그 프로젝트가 선언한 패키지 매니저 명령을 실행합니다. 임의의 셸 전체를 제공하지 않습니다.",
          "브라우저 안의 Docker와 네이티브 애드온은 이 터미널의 범위가 아닙니다."
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
        { type: "ul", items: [
          "Open, edit, and save project files from the file tree.",
          "The project terminal runs the package-manager commands that project declares. It does not offer an arbitrary shell.",
          "Docker in the browser and native addons are outside that terminal."
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
        { type: "ul", items: [
          "셀프호스트 Core",
          "데스크톱 Chrome",
          "Vite 프로젝트를 열고, 선언된 패키지를 설치하고, 편집하고, 미리보기"
        ] },
        { type: "h2", text: "범위 밖" },
        { type: "ul", items: [
          "매니지드 클라우드",
          "임의의 npm 패키지 전체",
          "모바일 Safari",
          "브라우저 안의 Docker",
          "네이티브 애드온"
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
        { type: "ul", items: [
          "Self-hosted Core",
          "Desktop Chrome",
          "Open a Vite project, install its declared packages, edit, and preview"
        ] },
        { type: "h2", text: "Outside the path" },
        { type: "ul", items: [
          "Managed cloud",
          "Arbitrary npm packages as a whole",
          "Mobile Safari",
          "Docker in the browser",
          "Native addons"
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
        { type: "p", text: "패키지에는 system_wasm.wasm, 시스템 워커, 프로세스 워커, Next·Vite·Yarn 실행 파일이 들어 있습니다. 아래 코드는 복사할 수 있습니다. createContainer와 runtime은 편집기 안에 이미 들어와 있습니다. 런타임 안의 임의 JavaScript 평가는 막혀 있으므로 container.run에 넣은 소스 문자열은 실행되지 않습니다. 기본 예시는 entrypoint fs-smoke로 워크스페이스에 hello를 쓰고, 반환값 value는 hello, size는 5입니다." },
        { type: "p", text: "실행은 Cross-Origin-Embedder-Policy: require-corp 와 Cross-Origin-Opener-Policy: same-origin 이 있는 문서 개발 서버에서만 합니다. GitHub Pages는 그 헤더를 붙일 수 없으므로, 공개 사이트에서는 예시를 보여 주고 부팅 성공으로 표시하지 않습니다." },
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
        { type: "p", text: "The package includes system_wasm.wasm, the system worker, the process worker, and the Next, Vite, and Yarn executables. The sample below can be copied. createContainer and runtime are already in scope in the editor. Arbitrary JavaScript evaluation inside the runtime is disabled, so a source string passed to container.run does not execute. The default sample uses the fs-smoke entrypoint, writes hello into the workspace, and returns value hello with size 5." },
        { type: "p", text: "The run button works only on the docs dev server, which sends Cross-Origin-Embedder-Policy: require-corp and Cross-Origin-Opener-Policy: same-origin. GitHub Pages cannot send those headers, so the public site shows the sample and does not report a successful boot." },
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
        { type: "code", text: "npm install @nuriteo/sdk@beta" },
        { type: "p", text: "패키지는 ESM과 CommonJS, 타입 선언을 냅니다. repository는 github.com/ByeongGi/nuriteo 입니다. 배포에는 npm 배포 증명과 SLSA provenance가 붙습니다. 증명은 빌드 출처이고 동작 보장은 아닙니다." },
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
        { type: "code", text: "npm install @nuriteo/sdk@beta" },
        { type: "p", text: "The package publishes ESM, CommonJS, and type declarations. repository is github.com/ByeongGi/nuriteo. Publishes carry an npm publish attestation and SLSA provenance. Provenance records where the build came from. It is not a behavior guarantee." },
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
        { type: "code", text: "const container = createContainer({\n  systemWorkerUrl,\n  processWorkerUrl,\n  systemWasmUrl\n});\nconst ready = await container.boot({ timeoutMs: 20_000 });\ncontainer.status;\ncontainer.metrics;\nawait container.systemMetrics();\nawait container.teardown();" }
      ]
    },
    en: {
      nav: "Container",
      eyebrow: "SDK",
      title: "Boot with createContainer() and read status.",
      lead: "A Nuriteo instance exposes boot, run, teardown, status, metrics, and systemMetrics. The service collection is services.",
      blocks: [
        { type: "code", text: "const container = createContainer({\n  systemWorkerUrl,\n  processWorkerUrl,\n  systemWasmUrl\n});\nconst ready = await container.boot({ timeoutMs: 20_000 });\ncontainer.status;\ncontainer.metrics;\nawait container.systemMetrics();\nawait container.teardown();" }
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
        { type: "code", text: "await container.services.fs.writeFile(\"/workspace/app.tsx\", source);\nconst text = await container.services.fs.readFile(\"/workspace/app.tsx\");\nawait container.services.fs.readdir(\"/workspace\");\nawait container.services.fs.mkdir(\"/workspace/src\", { recursive: true });\nconst stop = container.services.fs.watch(\"/workspace\", (event) => event.type);" }
      ]
    },
    en: {
      nav: "Files",
      eyebrow: "SDK",
      title: "Use services.fs for files.",
      lead: "The API reads, writes, lists directories, creates them, deletes, and watches. Without a filesystem adapter the call fails with SdkError ESDK_ADAPTER_MISSING.",
      blocks: [
        { type: "code", text: "await container.services.fs.writeFile(\"/workspace/app.tsx\", source);\nconst text = await container.services.fs.readFile(\"/workspace/app.tsx\");\nawait container.services.fs.readdir(\"/workspace\");\nawait container.services.fs.mkdir(\"/workspace/src\", { recursive: true });\nconst stop = container.services.fs.watch(\"/workspace\", (event) => event.type);" }
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
        { type: "code", text: "await container.services.packages.install({ packageManager: \"pnpm\" });\nawait container.services.packages.run(\"dev\");\nawait container.services.packages.exec(\"vite\", { args: [\"build\"] });" }
      ]
    },
    en: {
      nav: "Packages",
      eyebrow: "SDK",
      title: "Install declared packages with services.packages.",
      lead: "The managers are npm, pnpm, and Yarn. Script and binary execution use the same API. Without a package-manager adapter the call fails.",
      blocks: [
        { type: "code", text: "await container.services.packages.install({ packageManager: \"pnpm\" });\nawait container.services.packages.run(\"dev\");\nawait container.services.packages.exec(\"vite\", { args: [\"build\"] });" }
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
        { type: "code", text: "const handle = await container.services.processes.spawn({\n  command: \"pnpm\",\n  args: [\"install\"],\n  cwd: \"/workspace\",\n  env: { CI: \"1\" }\n});\nconst result = await handle.wait();" }
      ]
    },
    en: {
      nav: "Processes",
      eyebrow: "SDK",
      title: "Run a command with services.processes.spawn.",
      lead: "Set the working directory and environment. The handle writes input, resizes, signals, and waits for exit.",
      blocks: [
        { type: "code", text: "const handle = await container.services.processes.spawn({\n  command: \"pnpm\",\n  args: [\"install\"],\n  cwd: \"/workspace\",\n  env: { CI: \"1\" }\n});\nconst result = await handle.wait();" }
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
        { type: "code", text: "const assets = resolveNuriteoWorkerAssets(new URL(\"./\", import.meta.url));\nawait registerNuriteoPreviewServiceWorker({ scriptUrl: \"/preview-sw.js\" });\nawait container.services.preview.setPreviewScript(\"pnpm dev\");\nconst ports = await container.services.preview.ports();\nreturn { systemWorkerUrl: assets.systemWorkerUrl.href, ports };" },
        { type: "p", text: "resolveNuriteoWorkerAssets()가 돌려주는 필드는 systemWorkerUrl, processWorkerUrl, systemWasmUrl입니다. systemWasmUrl은 assets/system_wasm.wasm을 가리킵니다. 미리보기 서비스 워커 주소는 scriptUrl로 따로 넘깁니다. 등록 실패 코드는 ESDK_SERVICE_WORKER_UNAVAILABLE과 ESDK_SERVICE_WORKER_REGISTRATION_FAILED입니다." }
      ]
    },
    en: {
      nav: "Preview and workers",
      eyebrow: "SDK",
      title: "Read open ports and worker URLs.",
      lead: "services.preview reports open ports and Preview events. Registering a service worker where none exists throws SdkError.",
      blocks: [
        { type: "code", text: "const assets = resolveNuriteoWorkerAssets(new URL(\"./\", import.meta.url));\nawait registerNuriteoPreviewServiceWorker({ scriptUrl: \"/preview-sw.js\" });\nawait container.services.preview.setPreviewScript(\"pnpm dev\");\nconst ports = await container.services.preview.ports();\nreturn { systemWorkerUrl: assets.systemWorkerUrl.href, ports };" },
        { type: "p", text: "resolveNuriteoWorkerAssets() returns systemWorkerUrl, processWorkerUrl, and systemWasmUrl. systemWasmUrl points at assets/system_wasm.wasm. Pass the preview service worker separately as scriptUrl. Registration failures use ESDK_SERVICE_WORKER_UNAVAILABLE and ESDK_SERVICE_WORKER_REGISTRATION_FAILED." }
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
        { type: "code", text: "const archive = await container.services.projects.export();\nawait container.services.projects.import(archive);" }
      ]
    },
    en: {
      nav: "Project bundles",
      eyebrow: "SDK",
      title: "Export and import a bundle with services.projects.",
      lead: "The project adapter produces the bundle bytes and reads them back. Without that adapter the call fails.",
      blocks: [
        { type: "code", text: "const archive = await container.services.projects.export();\nawait container.services.projects.import(archive);" }
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
        { type: "code", text: "const container = await createNuriteoWebContainer().boot();\nawait container.mount(createNuriteoMountSnapshot({\n  \"package.json\": \"{\\\"name\\\":\\\"demo\\\"}\"\n}));\nconst process = await container.spawn(\"pnpm\", [\"install\"]);\ncontainer.on(\"server-ready\", (event) => event.url);\nawait container.teardown();" },
        { type: "p", text: "이벤트 이름은 port, server-ready, server-close입니다." }
      ]
    },
    en: {
      nav: "WebContainer-shaped entry",
      eyebrow: "SDK",
      title: "Keep boot, files, and commands on createNuriteoWebContainer().",
      lead: "The default COEP mode is require-corp. Boot still proceeds without a Preview adapter. Preview events are the part that stays quiet.",
      blocks: [
        { type: "code", text: "const container = await createNuriteoWebContainer().boot();\nawait container.mount(createNuriteoMountSnapshot({\n  \"package.json\": \"{\\\"name\\\":\\\"demo\\\"}\"\n}));\nconst process = await container.spawn(\"pnpm\", [\"install\"]);\ncontainer.on(\"server-ready\", (event) => event.url);\nawait container.teardown();" },
        { type: "p", text: "The event names are port, server-ready, and server-close." }
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
        { type: "p", text: "SdkError 코드는 ESDK_ADAPTER_MISSING, ESDK_INVALID_ARGUMENT, ESDK_LIFECYCLE_FAILED, ESDK_PATH_INVALID, ESDK_SERVICE_WORKER_UNAVAILABLE, ESDK_SERVICE_WORKER_REGISTRATION_FAILED, ESDK_SYMLINK_UNSUPPORTED입니다." }
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
        { type: "p", text: "SdkError codes are ESDK_ADAPTER_MISSING, ESDK_INVALID_ARGUMENT, ESDK_LIFECYCLE_FAILED, ESDK_PATH_INVALID, ESDK_SERVICE_WORKER_UNAVAILABLE, ESDK_SERVICE_WORKER_REGISTRATION_FAILED, and ESDK_SYMLINK_UNSUPPORTED." }
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
        { type: "code", text: "pnpm dev\npnpm dev:web\npnpm dev:stack:down\npnpm dev:stack:reset" },
        { type: "ul", items: [
          "Rust 소스 변경은 Core를 다시 빌드하고 재시작합니다.",
          "Web 변경은 Next.js HMR로 저장 즉시 갱신됩니다. Web만 다시 띄울 때는 pnpm dev:web을 씁니다.",
          "데이터 스택을 멈추되 데이터를 남길 때는 pnpm dev:stack:down입니다.",
          "데이터와 인증정보를 지울 때만 pnpm dev:stack:reset을 씁니다."
        ] },
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
        { type: "code", text: "pnpm dev\npnpm dev:web\npnpm dev:stack:down\npnpm dev:stack:reset" },
        { type: "ul", items: [
          "A Rust source change rebuilds and restarts Core.",
          "A Web change refreshes through Next.js HMR. Use pnpm dev:web to start Web alone.",
          "pnpm dev:stack:down stops the data stack and keeps the data.",
          "pnpm dev:stack:reset deletes data and credentials, and only that command does so."
        ] },
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
        { type: "ul", items: [
          "pnpm check:workspace",
          "pnpm check:types",
          "pnpm test:web",
          "pnpm test:workspace-runtime",
          "cargo test --workspace",
          "pnpm package:sdk 다음 pnpm test:sdk-consumer",
          "pnpm --filter @nuriteo/docs test",
          "pnpm --filter @nuriteo/docs typecheck"
        ] }
      ]
    },
    en: {
      nav: "Checks and tests",
      eyebrow: "Develop",
      title: "Start with the checks people run often.",
      lead: "Fast CI runs the workspace check, the dev stack, the self-hosted baseline, types, and tests. Release checks that skip missing planning documents are not listed here.",
      blocks: [
        { type: "ul", items: [
          "pnpm check:workspace",
          "pnpm check:types",
          "pnpm test:web",
          "pnpm test:workspace-runtime",
          "cargo test --workspace",
          "pnpm package:sdk, then pnpm test:sdk-consumer",
          "pnpm --filter @nuriteo/docs test",
          "pnpm --filter @nuriteo/docs typecheck"
        ] }
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
