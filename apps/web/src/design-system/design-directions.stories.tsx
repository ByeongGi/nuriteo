import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { ReactNode } from "react";

import { Button } from "#src/components/ui/button.tsx";
import { Input } from "#src/components/ui/input.tsx";

const directionProjects = [
  { initial: "R", name: "런타임 편집기", state: "정상", time: "2분 전" },
  { initial: "P", name: "미리보기 서비스", state: "빌드 중", time: "18분 전" },
  { initial: "D", name: "디자인 시스템", state: "초안", time: "1시간 전" }
] as const;

function DirectionStage({ children, description, label }: Readonly<{
  children: ReactNode;
  description: string;
  label: string;
}>) {
  return (
    <main className="direction-stage">
      <header><div><p>DESIGN DIRECTION</p><h1>{label}</h1></div><p>{description}</p></header>
      {children}
    </main>
  );
}

function FocusedSaaS() {
  return (
    <DirectionStage description="명확한 현재 위치와 하나의 Primary action을 중심으로 하는 범용 제품형입니다. 대부분의 사용자에게 가장 빠르게 학습됩니다." label="Focused SaaS">
      <div className="direction-window direction-focused">
        <aside><div className="direction-brand"><b>N</b><strong>NURITEO</strong></div><Button type="button"><span>누리터 팀<small>Organization</small></span><b>⌄</b></Button><nav>{["홈", "프로젝트", "워크스페이스", "조직", "알림"].map((item, index) => <a aria-current={index === 1 ? "page" : undefined} href="#focused" key={item}><i />{item}</a>)}</nav><div className="direction-profile"><span>BK</span><div><strong>병기</strong><small>관리자</small></div></div></aside>
        <section id="focused"><header><div><small>누리터 팀 / Projects</small><h2>프로젝트</h2><p>최근 작업을 이어가거나 새로운 프로젝트를 시작하세요.</p></div><Button className="direction-primary" type="button">+ 새 프로젝트</Button></header><div className="direction-toolbar"><label>⌕<Input aria-label="프로젝트 검색" placeholder="프로젝트 검색" /></label><span><Button className="is-active" type="button">활성 12</Button><Button type="button">보관 3</Button></span></div><div className="direction-table"><header><span>프로젝트</span><span>상태</span><span>최근 작업</span><span /></header>{directionProjects.map((project) => <article key={project.name}><div><b>{project.initial}</b><span><strong>{project.name}</strong><small>nuriteo/{project.name.replaceAll(" ", "-")}</small></span></div><em>{project.state}</em><time>{project.time}</time><Button type="button">•••</Button></article>)}</div></section>
      </div>
    </DirectionStage>
  );
}

function DenseStudio() {
  return (
    <DirectionStage description="작은 화면에서도 많은 상태와 작업을 빠르게 오갈 수 있는 전문가용입니다. IDE와 관리자 화면에 가장 잘 맞습니다." label="Dense Studio">
      <div className="direction-window direction-dense">
        <header><div className="direction-brand"><b>N</b><strong>NURITEO</strong></div><Button type="button">누리터 팀⌄</Button><nav>{["프로젝트", "조직", "운영", "설정"].map((item, index) => <a className={index === 0 ? "is-active" : ""} href="#dense" key={item}>{item}</a>)}</nav><label>⌘ K　검색 또는 명령</label><span>●　BK</span></header>
        <div className="direction-dense__body"><aside><Button className="is-active" type="button">P</Button><Button type="button">⌘</Button><Button type="button">↗</Button><Button type="button">⚙</Button></aside><section id="dense"><header><div><small>PROJECTS / ACTIVE</small><h2>프로젝트</h2></div><div><Button type="button">필터</Button><Button className="direction-primary" type="button">새 프로젝트</Button></div></header><div className="direction-dense__metrics"><span><small>활성</small><b>12</b></span><span><small>실행 중</small><b>4</b></span><span><small>주의 필요</small><b>1</b></span></div><div className="direction-dense__list">{directionProjects.map((project, index) => <article className={index === 0 ? "is-selected" : ""} key={project.name}><b>{project.initial}</b><div><strong>{project.name}</strong><span>main · v{18 - index}</span></div><em>{project.state}</em><time>{project.time}</time></article>)}</div></section><aside className="direction-inspector"><header><span>선택됨</span><Button type="button">×</Button></header><div><b>R</b><h3>런타임 편집기</h3><p>브라우저 기반 프로젝트 편집기</p></div><dl><dt>상태</dt><dd>정상</dd><dt>브랜치</dt><dd>main</dd><dt>버전</dt><dd>v18</dd></dl><Button className="direction-primary" type="button">Studio 열기</Button><Button type="button">프로젝트 설정</Button></aside></div>
      </div>
    </DirectionStage>
  );
}

function CalmWorkspace() {
  return (
    <DirectionStage description="부드러운 블루 뉴트럴과 넉넉한 여백으로 정보 피로를 낮춘 방향입니다. 협업과 일반 업무 화면에 자연스럽습니다." label="Calm Workspace">
      <div className="direction-window direction-calm">
        <header><div className="direction-brand"><b>N</b><strong>NURITEO</strong></div><nav>{["작업", "공유", "알림"].map((item, index) => <a className={index === 0 ? "is-active" : ""} href="#calm" key={item}>{item}</a>)}</nav><Button type="button">누리터 팀　⌄</Button><span>BK</span></header>
        <main id="calm"><section className="direction-calm__hero"><div><small>좋은 오후예요, 병기님</small><h2>어떤 작업을 이어갈까요?</h2><p>최근 프로젝트와 팀의 변경 사항을 한곳에서 확인하세요.</p></div><Button className="direction-primary" type="button">새 프로젝트 시작</Button></section><section className="direction-calm__recent"><header><h3>최근 프로젝트</h3><a href="#calm">전체 보기</a></header><div>{directionProjects.map((project, index) => <article key={project.name}><div><b>{project.initial}</b><span>{index === 0 ? "오늘" : index === 1 ? "어제" : "월요일"}</span></div><h3>{project.name}</h3><p>{index === 0 ? "코드 편집과 미리보기" : index === 1 ? "격리된 실행 환경" : "NURITEO UI foundation"}</p><footer><em>{project.state}</em><time>{project.time}</time></footer></article>)}</div></section><section className="direction-calm__activity"><header><h3>팀 활동</h3><span>새 소식 3개</span></header><p><b>이나라</b> 님이 미리보기 서비스에 변경 사항을 저장했습니다.</p><p><b>박해솔</b> 님이 디자인 시스템 프로젝트에 참여했습니다.</p></section></main>
      </div>
    </DirectionStage>
  );
}

const meta = {
  parameters: { layout: "fullscreen" },
  title: "UX/Design directions"
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Focused: Story = { render: () => <FocusedSaaS /> };
export const Dense: Story = { render: () => <DenseStudio /> };
export const Calm: Story = { render: () => <CalmWorkspace /> };
