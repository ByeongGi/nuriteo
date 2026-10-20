import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { ReactNode } from "react";

type ComparisonProps = Readonly<{
  asIs: ReactNode;
  summary: string;
  title: string;
  toBe: ReactNode;
}>;

const navItems = ["홈", "프로젝트", "워크스페이스", "조직", "보안"] as const;
const projects = [
  { meta: "2분 전 · 정상", name: "런타임 편집기" },
  { meta: "18분 전 · 빌드 중", name: "미리보기 서비스" },
  { meta: "1시간 전 · 초안", name: "디자인 시스템" }
] as const;

function Comparison({ asIs, summary, title, toBe }: ComparisonProps) {
  return (
    <main className="ux-comparison">
      <header className="ux-comparison__intro">
        <div>
          <p>USABILITY STUDY</p>
          <h1>{title}</h1>
        </div>
        <p>{summary}</p>
      </header>
      <div className="ux-comparison__grid">
        <section className="ux-comparison__column ux-comparison__column--before">
          <header><span>AS-IS</span><p>현재 구조</p></header>
          {asIs}
        </section>
        <section className="ux-comparison__column ux-comparison__column--after">
          <header><span>TO-BE</span><p>개선 방향</p></header>
          {toBe}
        </section>
      </div>
    </main>
  );
}

function AsIsShell() {
  return (
    <div className="ux-window ux-window--as-is">
      <div className="ux-as-is-header">
        <div><small>AUTHENTICATED WORKSPACE</small><strong>Signed in as 병기</strong></div>
        <span>byeonggi@example.com</span>
      </div>
      <nav className="ux-as-is-links" aria-label="기존 전역 메뉴">
        <a href="#shell">Workspaces</a><a href="#shell">Projects</a><a href="#shell">Organizations</a>
        <a href="#shell">Security</a><a href="#shell">Connected identities</a><a href="#shell">Access tokens</a>
        <a href="#shell">Notifications</a><a href="#shell">Administration</a>
      </nav>
      <section className="ux-as-is-page" id="shell">
        <small>CHOOSE YOUR CONTEXT</small><h2>Workspaces</h2>
        <p>Personal work stays with your account. Organization work is shared with its members.</p>
        <article><div><strong>병기의 워크스페이스</strong><span>Personal Workspace</span></div><em>Current</em></article>
        <article><div><strong>누리터 팀</strong><span>Organization Workspace</span></div><em>Select</em></article>
      </section>
    </div>
  );
}

function ToBeShell() {
  return (
    <div className="ux-window ux-window--to-be">
      <aside className="ux-app-sidebar">
        <div className="ux-app-brand"><b>N</b><strong>NURITEO</strong></div>
        <button className="ux-workspace-switcher" type="button"><span>누리터 팀<small>Organization</small></span><b>⌄</b></button>
        <nav aria-label="개선 전역 메뉴">
          {navItems.map((item, index) => <a aria-current={index === 1 ? "page" : undefined} href="#shell-improved" key={item}><i aria-hidden="true" />{item}</a>)}
        </nav>
        <div className="ux-app-user"><span>BK</span><div><strong>병기</strong><small>관리자</small></div><b>•••</b></div>
      </aside>
      <section className="ux-app-content" id="shell-improved">
        <header><div><small>누리터 팀</small><h2>프로젝트</h2></div><div><button type="button" aria-label="알림">●</button><button className="ux-primary-action" type="button">새 프로젝트</button></div></header>
        <div className="ux-app-summary"><p>최근 작업을 이어가거나 새 프로젝트를 시작하세요.</p><span>활성 프로젝트 12개</span></div>
        <div className="ux-app-cards">
          {projects.map((project, index) => <article key={project.name}><div><b>{index === 0 ? "R" : index === 1 ? "P" : "D"}</b><strong>{project.name}</strong></div><span>{project.meta}</span></article>)}
        </div>
      </section>
    </div>
  );
}

function ProductShellComparison() {
  return (
    <Comparison
      asIs={<AsIsShell />}
      summary="평면적인 링크 모음을 공간 중심 navigation으로 바꿔 현재 위치, workspace context, 주요 행동을 한눈에 파악하도록 합니다."
      title="제품 Shell과 전역 탐색"
      toBe={<ToBeShell />}
    />
  );
}

function AsIsProjects() {
  return (
    <div className="ux-window ux-projects ux-projects--as-is">
      <header><small>WORKSPACE DEVELOPMENT</small><h2>Projects</h2><p>Create, archive, and share browser development Projects.</p></header>
      <nav><a href="#projects">Personal</a><a href="#projects">누리터 팀</a></nav>
      <div className="ux-projects__body" id="projects">
        <aside>
          <form><h3>Create Project</h3><label>Slug<input value="" readOnly /></label><label>Name<input value="" readOnly /></label><button type="button">Create Project</button></form>
          <div className="ux-filter-links"><a href="#projects">active</a><a href="#projects">archived</a><a href="#projects">all</a></div>
          {projects.map((project) => <a className="ux-project-row" href="#projects" key={project.name}><strong>{project.name}</strong><span>{project.meta}</span></a>)}
        </aside>
        <section><small>ACTIVE · VERSION 18</small><h3>런타임 편집기</h3><p>runtime-editor</p><a href="#projects">Manage Project tokens</a><label>Project name<input value="런타임 편집기" readOnly /></label><button type="button">Save name</button><hr /><h4>Lifecycle</h4><button type="button">Archive</button></section>
      </div>
    </div>
  );
}

function ToBeProjects() {
  return (
    <div className="ux-window ux-projects ux-projects--to-be">
      <header className="ux-project-toolbar"><div><small>누리터 팀</small><h2>프로젝트</h2></div><button className="ux-primary-action" type="button">+ 새 프로젝트</button></header>
      <div className="ux-project-command"><label><span aria-hidden="true">⌕</span><input aria-label="프로젝트 검색" placeholder="프로젝트 검색" /></label><div><button className="is-active" type="button">활성 12</button><button type="button">보관 3</button></div></div>
      <div className="ux-project-list">
        <div className="ux-project-list__heading"><span>프로젝트</span><span>상태</span><span>최근 작업</span><span /></div>
        {projects.map((project, index) => (
          <article key={project.name}>
            <div><b>{index === 0 ? "R" : index === 1 ? "P" : "D"}</b><span><strong>{project.name}</strong><small>{index === 0 ? "runtime-editor" : index === 1 ? "preview-service" : "design-system"}</small></span></div>
            <em className={index === 1 ? "is-building" : index === 2 ? "is-draft" : ""}>{index === 0 ? "정상" : index === 1 ? "빌드 중" : "초안"}</em>
            <time>{index === 0 ? "2분 전" : index === 1 ? "18분 전" : "1시간 전"}</time>
            <button type="button" aria-label={`${project.name} 더보기`}>•••</button>
          </article>
        ))}
      </div>
      <footer><span>12개 중 3개 표시</span><button type="button">다음</button></footer>
    </div>
  );
}

function ProjectWorkspaceComparison() {
  return (
    <Comparison
      asIs={<AsIsProjects />}
      summary="상시 노출된 생성·수정·수명주기 폼을 맥락 행동으로 분리하고, 탐색 단계에서는 검색과 상태 비교에 집중합니다."
      title="프로젝트 탐색과 관리"
      toBe={<ToBeProjects />}
    />
  );
}

function EditorCanvas({ improved = false }: Readonly<{ improved?: boolean }>) {
  return (
    <div className={`ux-editor ${improved ? "ux-editor--improved" : ""}`}>
      <nav><small>FILES</small><button className="is-active" type="button">▾ src</button><button type="button">　App.tsx</button><button type="button">　main.tsx</button><button type="button">▸ public</button><button type="button">　package.json</button></nav>
      <section><header><span>App.tsx</span>{improved ? <span>×</span> : null}</header><pre><i>1</i> <b>export default</b> function App() &#123;{"\n"}<i>2</i>　return ({"\n"}<i>3</i>　　&lt;main&gt;{"\n"}<i>4</i>　　　&lt;h1&gt;Hello, Nuriteo&lt;/h1&gt;{"\n"}<i>5</i>　　&lt;/main&gt;{"\n"}<i>6</i>　){"\n"}<i>7</i> &#125;</pre><footer><span>TypeScript React</span><span>Ln 4, Col 12</span></footer></section>
      <aside><header><strong>{improved ? "미리보기" : "Preview"}</strong><span>{improved ? "실행 중" : "idle · HMR idle"}</span></header><div className="ux-preview-pane"><b>N</b><strong>Hello, Nuriteo</strong><small>브라우저에서 바로 만드는 프로젝트</small></div><section><header><strong>Terminal</strong><span>＋</span></header><pre>$ pnpm dev{"\n"}<em>ready in 428ms</em>{"\n"}➜ Local: localhost:5173</pre></section></aside>
    </div>
  );
}

function AsIsIde() {
  return (
    <div className="ux-window ux-ide ux-ide--as-is">
      <header><div><small>Browser workspace · ready</small><strong>런타임 편집기 IDE</strong></div><div><span>Not saved to server in this session</span><button type="button">Save to server</button><button type="button">Stop workspace</button></div></header>
      <div className="ux-history-strip"><strong>Project history</strong><button type="button">Create checkpoint</button><button type="button">Refresh history</button></div>
      <EditorCanvas />
    </div>
  );
}

function ToBeIde() {
  return (
    <div className="ux-window ux-ide ux-ide--to-be">
      <header className="ux-ide-toolbar"><div><button type="button" aria-label="프로젝트로 돌아가기">‹</button><span><strong>런타임 편집기</strong><small>저장됨 · v18</small></span></div><div><button type="button">버전 기록</button><button className="ux-primary-action" type="button">▶ 미리보기 실행</button><button type="button" aria-label="더보기">•••</button></div></header>
      <div className="ux-ide-context"><span><b aria-hidden="true" /> 로컬 초안 동기화됨</span><p><kbd>⌘</kbd><kbd>S</kbd> 서버에 저장</p></div>
      <EditorCanvas improved />
    </div>
  );
}

function BrowserIdeComparison() {
  return (
    <Comparison
      asIs={<AsIsIde />}
      summary="저장·실행·중지·기록 행동을 한 레벨에 두지 않고, 현재 작업의 핵심인 편집과 미리보기를 중심으로 제어 순서를 다시 세웁니다."
      title="브라우저 IDE 작업 화면"
      toBe={<ToBeIde />}
    />
  );
}

function AsIsEntry() {
  return (
    <div className="ux-window ux-entry ux-entry--as-is">
      <section>
        <small>WELCOME BACK</small><h2>Sign in to NURITEO</h2>
        <p>Use the local account provided by your administrator.</p>
        <button type="button">Continue with Company SSO</button>
        <p className="ux-entry__divider">Or use your local account.</p>
        <label>Email<input type="email" readOnly /></label>
        <label>Password<input type="password" readOnly /></label>
        <button type="button">Sign in</button>
      </section>
    </div>
  );
}

function ToBeEntry() {
  return (
    <div className="ux-window ux-entry ux-entry--to-be">
      <aside><div className="ux-entry__brand"><b>N</b><strong>NURITEO</strong></div><div><span>SELF-HOSTED WORKSPACE</span><h2>팀의 개발 환경으로<br />안전하게 돌아오세요.</h2><p>프로젝트와 실행 환경은 조직의 인프라 안에 유지됩니다.</p></div><small>보안 연결 · 서울 리전</small></aside>
      <section>
        <div><small>다시 오신 것을 환영합니다</small><h2>로그인</h2><p>회사 계정으로 계속하거나 로컬 계정을 사용하세요.</p></div>
        <button className="ux-primary-action" type="button">Company SSO로 계속</button>
        <div className="ux-entry__divider"><span>또는</span></div>
        <label>이메일<input type="email" placeholder="name@company.com" /></label>
        <label>비밀번호<input type="password" placeholder="비밀번호 입력" /></label>
        <button type="button">로컬 계정으로 로그인</button>
        <a href="#entry-help">로그인에 문제가 있나요?</a>
      </section>
    </div>
  );
}

function EntryAndSecurityComparison() {
  return <Comparison asIs={<AsIsEntry />} summary="인증 수단의 우선순위를 분명히 하고, 제품 신뢰 정보와 복구 경로를 로그인 맥락 안에서 제공합니다." title="로그인과 보안 진입" toBe={<ToBeEntry />} />;
}

function AsIsCollaboration() {
  return (
    <div className="ux-window ux-collab ux-collab--as-is">
      <header><small>COLLABORATION</small><h2>Organizations</h2><p>Create an Organization and manage its profile, invitations, and members.</p></header>
      <nav><a href="#collab">Personal</a><a href="#collab">누리터 팀</a></nav>
      <div className="ux-collab__columns" id="collab"><aside><h3>Create Organization</h3><label>Slug<input readOnly /></label><label>Display name<input readOnly /></label><button type="button">Create Organization</button></aside><section><h3>누리터 팀</h3><label>Display name<input value="누리터 팀" readOnly /></label><button type="button">Save name</button><hr /><h3>Invite member</h3><label>Email<input readOnly /></label><label>Role<select><option>Member</option></select></label><button type="button">Issue invitation</button></section></div>
    </div>
  );
}

function ToBeCollaboration() {
  const members = [["김병기", "byeonggi@nuriteo.dev", "소유자"], ["이나라", "nara@nuriteo.dev", "관리자"], ["박해솔", "haesol@nuriteo.dev", "멤버"]] as const;
  return (
    <div className="ux-window ux-collab ux-collab--to-be">
      <header><div><small>누리터 팀</small><h2>멤버</h2></div><button className="ux-primary-action" type="button">멤버 초대</button></header>
      <nav><button className="is-active" type="button">멤버 8</button><button type="button">초대 대기 2</button><button type="button">팀 3</button></nav>
      <div className="ux-collab__search"><input aria-label="멤버 검색" placeholder="이름 또는 이메일 검색" /><select aria-label="역할 필터"><option>모든 역할</option></select></div>
      <div className="ux-member-list"><div><span>멤버</span><span>역할</span><span>최근 활동</span><span /></div>{members.map((member, index) => <article key={member[1]}><span className="ux-member"><b>{member[0].slice(0, 1)}</b><span><strong>{member[0]}</strong><small>{member[1]}</small></span></span><em>{member[2]}</em><time>{index === 0 ? "지금" : index === 1 ? "3시간 전" : "어제"}</time><button type="button" aria-label={`${member[0]} 메뉴`}>•••</button></article>)}</div>
    </div>
  );
}

function CollaborationComparison() {
  return <Comparison asIs={<AsIsCollaboration />} summary="조직 생성·프로필·초대·멤버 관리를 한 화면에 쌓지 않고, 선택한 조직 안에서 멤버 작업에 집중하도록 분리합니다." title="조직과 멤버 관리" toBe={<ToBeCollaboration />} />;
}

function AsIsNotifications() {
  return (
    <div className="ux-window ux-notifications ux-notifications--as-is"><header><small>ACCOUNT INBOX</small><h2>Notifications</h2><p>Review security, account access, collaboration, and operations updates.</p></header><section><div><h3>Inbox</h3><span><button type="button">Active</button><button type="button">Archived</button></span></div>{["새 멤버가 프로젝트에 참여했습니다", "서버 저장이 완료되었습니다", "보안 설정이 변경되었습니다"].map((item) => <article key={item}><div><small>COLLABORATION · OCT 20</small><strong>{item}</strong><p>관련된 변경 사항과 상태를 확인하세요.</p></div><span><button type="button">Mark read</button><button type="button">Archive</button></span></article>)}</section><section><h3>Preferences</h3><label><input type="checkbox" defaultChecked /> Account and access</label><label><input type="checkbox" defaultChecked /> Collaboration</label><button type="button">Save preferences</button></section></div>
  );
}

function ToBeNotifications() {
  return (
    <div className="ux-window ux-notifications ux-notifications--to-be"><header><div><small>계정</small><h2>알림</h2></div><button type="button">모두 읽음</button></header><div className="ux-notification-layout"><aside><button className="is-active" type="button">전체 <b>3</b></button><button type="button">보안</button><button type="button">협업</button><button type="button">운영</button><hr /><button type="button">보관함</button><button type="button">알림 설정</button></aside><section>{[["협업", "박해솔 님이 디자인 시스템 프로젝트에 참여했습니다.", "2분 전"], ["프로젝트", "런타임 편집기 v18 저장이 완료되었습니다.", "18분 전"], ["보안", "MFA 복구 코드가 다시 생성되었습니다.", "어제"]].map((item, index) => <article className={index === 0 ? "is-unread" : ""} key={item[1]}><i aria-hidden="true" /><div><span><em>{item[0]}</em><time>{item[2]}</time></span><strong>{item[1]}</strong><p>{index === 0 ? "새 멤버는 읽기 권한으로 시작합니다." : "세부 내용을 확인하거나 관련 화면으로 이동할 수 있습니다."}</p></div><button type="button" aria-label="알림 메뉴">•••</button></article>)}</section></div></div>
  );
}

function NotificationsComparison() {
  return <Comparison asIs={<AsIsNotifications />} summary="알림 처리와 환경설정을 분리하고, 분류·읽음 상태·관련 행동을 목록에서 바로 스캔할 수 있게 합니다." title="알림 센터" toBe={<ToBeNotifications />} />;
}

function AsIsTokens() {
  return (
    <div className="ux-window ux-tokens ux-tokens--as-is"><header><small>PERSONAL AUTOMATION</small><h2>Access tokens</h2><p>Issue narrowly scoped credentials.</p></header><section><h3>Issue a token</h3><label>Token name<input readOnly /></label><label>Expiry in days<input type="number" readOnly /></label><fieldset><legend>Scopes</legend>{["project:read", "project:write", "project:publish", "project:manage", "git:read", "git:write"].map((scope) => <label key={scope}><input type="checkbox" /> {scope}</label>)}</fieldset><button type="button">Issue token</button></section><section><h3>Tokens</h3><article><div><strong>Deploy key</strong><span>nur_7a8… · active · expires Oct 31</span></div><button type="button">Rotate</button><button type="button">Revoke</button></article></section></div>
  );
}

function ToBeTokens() {
  return (
    <div className="ux-window ux-tokens ux-tokens--to-be"><header><div><small>자동화</small><h2>액세스 토큰</h2><p>토큰은 발급 직후 한 번만 표시됩니다.</p></div><button className="ux-primary-action" type="button">새 토큰</button></header><div className="ux-token-summary"><article><span>활성 토큰</span><strong>3</strong></article><article><span>30일 내 만료</span><strong>1</strong></article><article><span>90일간 미사용</span><strong>1</strong></article></div><section><div><input aria-label="토큰 검색" placeholder="토큰 검색" /><button type="button">상태: 전체</button></div>{[["Deploy key", "배포", "오늘"], ["Local CLI", "개발", "3일 전"], ["Read-only audit", "읽기 전용", "사용 안 함"]].map((token) => <article key={token[0]}><div><strong>{token[0]}</strong><span><code>nur_7a8…</code> · {token[1]}</span></div><time>{token[2]}</time><em>활성</em><button type="button" aria-label={`${token[0]} 메뉴`}>•••</button></article>)}</section><aside><h3>권한 프리셋</h3><p>읽기 전용, 개발, 배포 중 목적에 맞는 최소 권한으로 시작합니다.</p></aside></div>
  );
}

function AccessTokensComparison() {
  return <Comparison asIs={<AsIsTokens />} summary="발급 폼보다 자격 증명 재고와 위험 신호를 먼저 보여주고, raw scope 대신 목적 기반 권한 프리셋을 제공합니다." title="액세스 토큰" toBe={<ToBeTokens />} />;
}

function AsIsAdmin() {
  return (
    <div className="ux-window ux-admin ux-admin--as-is"><nav>{["Operations", "Maintenance", "Backups", "Updates", "Settings", "Invitations", "MFA policy", "OIDC", "Registries", "Git providers", "Email delivery", "SMTP trust"].map((item) => <a href="#admin" key={item}>{item}</a>)}</nav><main id="admin"><header><small>INSTANCE ADMINISTRATION</small><h2>Settings</h2><p>Review deployment identity and change the bounded instance policy registry.</p></header><section><div><h3>Instance status</h3><em>Up to date</em></div><dl><dt>Release</dt><dd>0.12.0</dd><dt>Database schema</dt><dd>18</dd><dt>Registered settings</dt><dd>14</dd></dl></section><section><h3>Instance policy</h3>{["Audit retention", "Invitation expiry", "Runtime network"].map((item) => <article key={item}><div><strong>{item}</strong><p>Review and update this instance policy.</p></div><input value="30" readOnly /><button type="button">Review impact</button><button type="button">Apply change</button></article>)}</section></main></div>
  );
}

function ToBeAdmin() {
  return (
    <div className="ux-window ux-admin ux-admin--to-be"><aside><strong>Administration</strong>{[["상태", "운영 현황"], ["시스템", "유지보수"], ["시스템", "백업"], ["업데이트", "버전 관리"], ["정책", "인스턴스 설정"], ["보안", "인증 및 MFA"], ["연동", "외부 서비스"]].map((item, index) => <a className={index === 4 ? "is-active" : ""} href="#admin-improved" key={item[1]}><small>{item[0]}</small><span>{item[1]}</span></a>)}</aside><main id="admin-improved"><header><div><small>관리자 · 정책</small><h2>인스턴스 설정</h2></div><button type="button">변경 기록</button></header><div className="ux-admin-health"><span><b aria-hidden="true" /> 시스템 정상</span><p>마지막 확인 1분 전 · v0.12.0</p></div><label className="ux-admin-search">⌕<input aria-label="설정 검색" placeholder="설정 이름 또는 키 검색" /></label>{[["보안", "재인증 유효 시간", "30분"], ["보존", "감사 로그 보존 기간", "365일"], ["런타임", "기본 네트워크 정책", "제한됨"]].map((setting) => <section key={setting[1]}><div><small>{setting[0]}</small><h3>{setting[1]}</h3><p>변경 영향과 적용 시점을 먼저 확인합니다.</p></div><strong>{setting[2]}</strong><button type="button">검토</button></section>)}</main></div>
  );
}

function AdministrationComparison() {
  return <Comparison asIs={<AsIsAdmin />} summary="12개 메뉴를 시스템 영역별로 재구성하고, 설정 검색·시스템 상태·변경 검토를 한 작업 흐름으로 연결합니다." title="인스턴스 관리자" toBe={<ToBeAdmin />} />;
}

const meta = {
  parameters: { layout: "fullscreen" },
  title: "UX/AS-IS & TO-BE"
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const ProductShell: Story = { render: () => <ProductShellComparison /> };
export const ProjectWorkspace: Story = { render: () => <ProjectWorkspaceComparison /> };
export const BrowserIDE: Story = { render: () => <BrowserIdeComparison /> };
export const EntryAndSecurity: Story = { render: () => <EntryAndSecurityComparison /> };
export const Collaboration: Story = { render: () => <CollaborationComparison /> };
export const Notifications: Story = { render: () => <NotificationsComparison /> };
export const AccessTokens: Story = { render: () => <AccessTokensComparison /> };
export const Administration: Story = { render: () => <AdministrationComparison /> };
