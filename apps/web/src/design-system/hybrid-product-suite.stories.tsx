import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { ReactNode } from "react";

type NavigationItem = "홈" | "프로젝트" | "워크스페이스" | "조직" | "알림" | "보안" | "관리";

type ProductShellProps = Readonly<{
  active: NavigationItem;
  children: ReactNode;
  dense?: boolean;
  eyebrow: string;
  title: string;
  toolbar?: ReactNode;
}>;

const navigationItems: ReadonlyArray<Readonly<{ icon: string; label: NavigationItem }>> = [
  { icon: "⌂", label: "홈" },
  { icon: "P", label: "프로젝트" },
  { icon: "W", label: "워크스페이스" },
  { icon: "O", label: "조직" },
  { icon: "●", label: "알림" },
  { icon: "◇", label: "보안" },
  { icon: "A", label: "관리" }
];

const projects = [
  { branch: "main", initial: "R", name: "런타임 편집기", state: "정상", time: "2분 전", version: "v18" },
  { branch: "main", initial: "P", name: "미리보기 서비스", state: "빌드 중", time: "18분 전", version: "v17" },
  { branch: "design", initial: "D", name: "디자인 시스템", state: "초안", time: "1시간 전", version: "v16" }
] as const;

const members = [
  { initials: "BK", name: "김병기", email: "byeonggi@nuriteo.dev", role: "관리자", time: "방금" },
  { initials: "NR", name: "이나라", email: "nara@nuriteo.dev", role: "멤버", time: "12분 전" },
  { initials: "HS", name: "박해솔", email: "haesol@nuriteo.dev", role: "멤버", time: "1시간 전" }
] as const;

const notifications = [
  { detail: "main 브랜치 빌드가 완료되었습니다.", label: "미리보기 서비스", time: "방금", unread: true },
  { detail: "이나라 님이 새 체크포인트를 만들었습니다.", label: "런타임 편집기", time: "12분 전", unread: true },
  { detail: "박해솔 님이 프로젝트에 참여했습니다.", label: "디자인 시스템", time: "어제", unread: false }
] as const;

function Brand() {
  return <div className="hybrid-brand"><b>N</b><strong>NURITEO</strong></div>;
}

function ProductShell({ active, children, dense = false, eyebrow, title, toolbar }: ProductShellProps) {
  return (
    <main className={`hybrid-stage ${dense ? "hybrid-stage--dense" : ""}`}>
      <div className="hybrid-window">
        <aside className="hybrid-sidebar">
          <Brand />
          <button className="hybrid-workspace" type="button"><span>누리터 팀<small>Organization</small></span><b>⌄</b></button>
          <nav aria-label="제품 메뉴">
            {navigationItems.map((item) => (
              <a aria-current={item.label === active ? "page" : undefined} href={`#hybrid-${item.label}`} key={item.label}>
                <i aria-hidden="true">{item.icon}</i><span>{item.label}</span>
                {item.label === "알림" ? <em>2</em> : null}
              </a>
            ))}
          </nav>
          <div className="hybrid-profile"><span>BK</span><div><strong>병기</strong><small>관리자</small></div><b>•••</b></div>
        </aside>
        <section className="hybrid-content" id={`hybrid-${active}`}>
          <header className="hybrid-page-header">
            <div><small>{eyebrow}</small><h1>{title}</h1></div>
            <div className="hybrid-page-actions">{toolbar}<button aria-label="도움말" type="button">?</button></div>
          </header>
          {children}
        </section>
      </div>
    </main>
  );
}

function Status({ children, tone = "success" }: Readonly<{ children: ReactNode; tone?: "info" | "success" | "warning" }>) {
  return <span className={`hybrid-status hybrid-status--${tone}`}>{children}</span>;
}

function HomeScreen() {
  return (
    <ProductShell active="홈" eyebrow="누리터 팀" title="좋은 오후예요, 병기님" toolbar={<button className="hybrid-primary" type="button">새 프로젝트</button>}>
      <p className="hybrid-lead">최근 작업과 팀의 변화를 한곳에서 확인하고 바로 이어서 작업하세요.</p>
      <section className="hybrid-home-stats" aria-label="워크스페이스 현황">
        <article><span>활성 프로젝트</span><strong>12</strong><small>이번 주 +2</small></article>
        <article><span>실행 중</span><strong>4</strong><small>모두 정상</small></article>
        <article><span>팀 멤버</span><strong>8</strong><small>오늘 3명 활동</small></article>
      </section>
      <section className="hybrid-section hybrid-home-grid">
        <div className="hybrid-panel hybrid-recent">
          <header><div><h2>최근 프로젝트</h2><p>마지막 작업 위치에서 이어갑니다.</p></div><a href="#all-projects">전체 보기</a></header>
          <div>{projects.map((project) => <article key={project.name}><b>{project.initial}</b><div><strong>{project.name}</strong><span>{project.branch} · {project.version}</span></div><Status tone={project.state === "빌드 중" ? "info" : project.state === "초안" ? "warning" : "success"}>{project.state}</Status><time>{project.time}</time></article>)}</div>
        </div>
        <aside className="hybrid-activity"><header><h2>팀 활동</h2><span>오늘</span></header><ol><li><b>이나라</b><span>미리보기 서비스에 변경사항을 저장했습니다.</span><time>12분 전</time></li><li><b>박해솔</b><span>디자인 시스템에 참여했습니다.</span><time>1시간 전</time></li><li><b>김병기</b><span>런타임 편집기 v18을 배포했습니다.</span><time>2시간 전</time></li></ol></aside>
      </section>
    </ProductShell>
  );
}

function ProjectsScreen() {
  return (
    <ProductShell active="프로젝트" eyebrow="누리터 팀 / Projects" title="프로젝트" toolbar={<button className="hybrid-primary" type="button">+ 새 프로젝트</button>}>
      <div className="hybrid-command"><label>⌕<input aria-label="프로젝트 검색" placeholder="프로젝트 검색" /></label><div><button className="is-active" type="button">활성 12</button><button type="button">보관 3</button><button type="button">필터</button></div></div>
      <div className="hybrid-split">
        <section className="hybrid-data-list"><header><span>프로젝트</span><span>상태</span><span>최근 작업</span></header>{projects.map((project, index) => <article className={index === 0 ? "is-selected" : ""} key={project.name}><div><b>{project.initial}</b><span><strong>{project.name}</strong><small>{project.branch} · {project.version}</small></span></div><Status tone={project.state === "빌드 중" ? "info" : project.state === "초안" ? "warning" : "success"}>{project.state}</Status><time>{project.time}</time></article>)}</section>
        <aside className="hybrid-inspector"><header><span>선택된 프로젝트</span><button aria-label="닫기" type="button">×</button></header><div className="hybrid-inspector-title"><b>R</b><h2>런타임 편집기</h2><p>브라우저 기반 프로젝트 편집기</p></div><dl><dt>상태</dt><dd>정상</dd><dt>브랜치</dt><dd>main</dd><dt>버전</dt><dd>v18</dd><dt>소유자</dt><dd>누리터 팀</dd></dl><button className="hybrid-primary" type="button">Studio 열기</button><button type="button">프로젝트 설정</button></aside>
      </div>
    </ProductShell>
  );
}

function BrowserIdeScreen() {
  return (
    <ProductShell active="프로젝트" dense eyebrow="런타임 편집기 / main" title="Studio" toolbar={<><button type="button">버전 기록</button><button className="hybrid-primary" type="button">▶ 미리보기</button></>}>
      <div className="hybrid-ide-status"><span><i /> 저장됨 · v18</span><span>개발 서버 실행 중 · localhost:5173</span></div>
      <div className="hybrid-ide">
        <nav><header>EXPLORER <button type="button">＋</button></header><button className="is-active" type="button">▾ src</button><button type="button">　App.tsx</button><button type="button">　main.tsx</button><button type="button">▸ public</button><button type="button">　package.json</button></nav>
        <section><header><span>App.tsx</span><button aria-label="파일 닫기" type="button">×</button></header><pre><i>1</i> <b>export default</b> function App() &#123;{"\n"}<i>2</i>　return ({"\n"}<i>3</i>　　&lt;main&gt;{"\n"}<i>4</i>　　　&lt;h1&gt;Hello, Nuriteo&lt;/h1&gt;{"\n"}<i>5</i>　　&lt;/main&gt;{"\n"}<i>6</i>　){"\n"}<i>7</i> &#125;</pre><footer><span>TypeScript React</span><span>Ln 4, Col 12</span></footer></section>
        <aside><section><header><strong>미리보기</strong><span>● 실행 중</span></header><div><b>N</b><h2>Hello, Nuriteo</h2><p>브라우저에서 바로 만드는 프로젝트</p></div></section><section><header><strong>Terminal</strong><span>＋</span></header><pre>$ pnpm dev{"\n"}<em>ready in 428ms</em>{"\n"}➜ Local: localhost:5173</pre></section></aside>
      </div>
    </ProductShell>
  );
}

function EntryScreen() {
  return (
    <main className="hybrid-entry-stage"><div className="hybrid-entry-window"><aside><Brand /><div><span>SELF-HOSTED WORKSPACE</span><h1>팀의 개발 환경으로<br />안전하게 돌아오세요.</h1><p>프로젝트와 실행 환경은 조직의 인프라 안에 유지됩니다.</p></div><footer><i /> 보안 연결 · 서울 리전</footer></aside><section><header><small>다시 오신 것을 환영합니다</small><h2>로그인</h2><p>회사 계정으로 계속하거나 로컬 계정을 사용하세요.</p></header><button className="hybrid-primary" type="button">Company SSO로 계속</button><div className="hybrid-entry-divider"><span>또는</span></div><label>이메일<input type="email" placeholder="name@company.com" /></label><label>비밀번호<input type="password" placeholder="비밀번호 입력" /></label><button type="button">로컬 계정으로 로그인</button><a href="#login-help">로그인에 문제가 있나요?</a></section></div></main>
  );
}

function CollaborationScreen() {
  return (
    <ProductShell active="조직" eyebrow="누리터 팀 / Members" title="멤버와 권한" toolbar={<button className="hybrid-primary" type="button">멤버 초대</button>}>
      <p className="hybrid-lead">조직에 참여한 멤버와 프로젝트 접근 권한을 관리합니다.</p>
      <section className="hybrid-overview"><article><span>전체 멤버</span><strong>8</strong></article><article><span>관리자</span><strong>2</strong></article><article><span>대기 중 초대</span><strong>1</strong></article><div><span>기본 역할</span><button type="button">멤버 ⌄</button></div></section>
      <div className="hybrid-command"><label>⌕<input aria-label="멤버 검색" placeholder="이름 또는 이메일 검색" /></label><div><button className="is-active" type="button">전체</button><button type="button">관리자</button><button type="button">멤버</button></div></div>
      <section className="hybrid-member-list"><header><span>멤버</span><span>역할</span><span>최근 활동</span><span /></header>{members.map((member) => <article key={member.email}><div><b>{member.initials}</b><span><strong>{member.name}</strong><small>{member.email}</small></span></div><button type="button">{member.role}⌄</button><time>{member.time}</time><button aria-label={`${member.name} 더보기`} type="button">•••</button></article>)}</section>
    </ProductShell>
  );
}

function NotificationsScreen() {
  return (
    <ProductShell active="알림" eyebrow="누리터 팀 / Activity" title="알림" toolbar={<button type="button">모두 읽음</button>}>
      <div className="hybrid-notification-layout"><aside><button className="is-active" type="button"><span>전체</span><b>2</b></button><button type="button"><span>프로젝트</span><b>2</b></button><button type="button"><span>조직</span></button><button type="button"><span>시스템</span></button><hr /><label>이메일 알림 <input defaultChecked type="checkbox" /></label></aside><section><header><div><h2>최근 알림</h2><p>읽지 않은 알림 2개</p></div><button type="button">설정</button></header><div>{notifications.map((notification) => <article className={notification.unread ? "is-unread" : ""} key={notification.label}><i /><div><strong>{notification.label}</strong><p>{notification.detail}</p><time>{notification.time}</time></div><button aria-label={`${notification.label} 알림 더보기`} type="button">•••</button></article>)}</div></section></div>
    </ProductShell>
  );
}

function AccessTokensScreen() {
  return (
    <ProductShell active="보안" eyebrow="개인 설정 / Developer" title="액세스 토큰" toolbar={<button className="hybrid-primary" type="button">새 토큰 만들기</button>}>
      <div className="hybrid-security-note"><span>◇</span><div><strong>토큰은 생성할 때 한 번만 표시됩니다.</strong><p>필요한 범위와 만료 기간만 부여하고 안전한 곳에 보관하세요.</p></div><a href="#token-guide">보안 가이드</a></div>
      <section className="hybrid-token-stats"><article><span>활성 토큰</span><strong>3</strong></article><article><span>30일 내 만료</span><strong>1</strong></article><article><span>최근 사용</span><strong>8분 전</strong></article></section>
      <section className="hybrid-token-list"><header><div><h2>내 토큰</h2><p>개인 API 및 자동화에 사용하는 자격 증명입니다.</p></div><button type="button">필터</button></header><div><article><div><b>CI</b><span><strong>preview-deploy</strong><small>project:read · deployment:write</small></span></div><Status>활성</Status><time>8분 전 사용</time><button type="button">•••</button></article><article><div><b>CL</b><span><strong>local-cli</strong><small>project:read · workspace:write</small></span></div><Status tone="warning">12일 후 만료</Status><time>어제 사용</time><button type="button">•••</button></article></div></section>
    </ProductShell>
  );
}

function AdministrationScreen() {
  return (
    <ProductShell active="관리" dense eyebrow="Administration / Runtime" title="운영 관리" toolbar={<button type="button">감사 로그</button>}>
      <div className="hybrid-admin-health"><span><i /> 모든 시스템 정상</span><p>마지막 확인 방금 전</p><button type="button">상태 새로고침</button></div>
      <section className="hybrid-admin-grid"><article><header><span>활성 워크스페이스</span><b>24</b></header><div className="hybrid-meter"><i style={{ width: "72%" }} /></div><footer><span>용량 72%</span><strong>18 / 25</strong></footer></article><article><header><span>빌드 대기열</span><b>4</b></header><div className="hybrid-meter"><i style={{ width: "36%" }} /></div><footer><span>평균 대기 18초</span><strong>정상</strong></footer></article><article><header><span>스토리지</span><b>68 GB</b></header><div className="hybrid-meter"><i style={{ width: "54%" }} /></div><footer><span>128 GB 중</span><strong>54%</strong></footer></article></section>
      <section className="hybrid-runtime-list"><header><div><h2>실행 환경</h2><p>조직의 활성 런타임과 리소스 사용량입니다.</p></div><label>⌕<input aria-label="실행 환경 검색" placeholder="프로젝트 검색" /></label></header><div className="hybrid-runtime-head"><span>프로젝트</span><span>상태</span><span>CPU</span><span>메모리</span><span /></div>{projects.map((project, index) => <article key={project.name}><div><b>{project.initial}</b><span><strong>{project.name}</strong><small>runtime-{3421 + index}</small></span></div><Status>{index === 2 ? "대기" : "실행 중"}</Status><span>{[18, 42, 8][index]}%</span><span>{[512, 768, 256][index]} MB</span><button type="button">•••</button></article>)}</section>
    </ProductShell>
  );
}

const meta = {
  parameters: { layout: "fullscreen" },
  title: "UX/Hybrid product suite"
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Home: Story = { render: () => <HomeScreen /> };
export const Projects: Story = { render: () => <ProjectsScreen /> };
export const BrowserIDE: Story = { render: () => <BrowserIdeScreen /> };
export const EntryAndSecurity: Story = { render: () => <EntryScreen /> };
export const Collaboration: Story = { render: () => <CollaborationScreen /> };
export const Notifications: Story = { render: () => <NotificationsScreen /> };
export const AccessTokens: Story = { render: () => <AccessTokensScreen /> };
export const Administration: Story = { render: () => <AdministrationScreen /> };
