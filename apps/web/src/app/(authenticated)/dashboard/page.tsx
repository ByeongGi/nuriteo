import { getCurrentWorkspaces, listProjects } from "@nuriteo/api-client";
import type { Project, Workspace } from "@nuriteo/api-client";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect, unstable_rethrow } from "next/navigation";
import { tv } from "tailwind-variants";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { Badge } from "#src/components/ui/badge.tsx";
import { PageHeader } from "#src/components/ui/page-header.tsx";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { workspaceOwnerLabel } from "#src/lib/workspace-selection.ts";

export const metadata: Metadata = { title: "대시보드" };

const dashboardStyles = tv({
  slots: {
    root: "mx-auto grid w-full max-w-[82rem] gap-7 px-[clamp(1.25rem,4vw,3.5rem)] py-[clamp(2rem,4vw,3.75rem)] outline-none max-[48rem]:px-4 max-[48rem]:py-5",
    primaryAction: "inline-flex min-h-10 items-center justify-center rounded-md border border-primary bg-primary px-4 text-sm font-medium text-on-primary no-underline shadow-xs hover:bg-primary-strong",
    section: "grid gap-3",
    sectionHeader: "flex flex-wrap items-end justify-between gap-3",
    sectionCopy: "grid gap-1",
    sectionTitle: "m-0 text-lg font-semibold",
    sectionDescription: "m-0 text-sm text-muted-foreground",
    textLink: "text-sm font-medium text-link no-underline hover:underline",
    workspaceGrid: "grid gap-3 sm:grid-cols-2 xl:grid-cols-3",
    workspaceCard: "grid min-h-36 content-between gap-5 rounded-xl border border-muted-border bg-surface p-5 text-foreground no-underline shadow-xs transition-colors hover:border-strong-border hover:bg-hover",
    workspaceCopy: "grid min-w-0 gap-2",
    workspaceTitle: "m-0 truncate text-base font-semibold",
    workspaceDescription: "m-0 text-sm text-muted-foreground",
    workspaceAction: "flex items-center justify-between gap-3 text-sm font-medium text-link",
    empty: "grid min-h-44 place-content-center justify-items-center gap-3 rounded-xl border border-dashed border-muted-border bg-subtle p-6 text-center",
    emptyTitle: "m-0 text-base font-semibold",
    emptyDescription: "m-0 max-w-md text-sm leading-relaxed text-muted-foreground",
    actionGrid: "grid gap-3 sm:grid-cols-2",
    actionCard: "grid gap-2 rounded-xl border border-muted-border bg-surface p-5 text-foreground no-underline transition-colors hover:border-strong-border hover:bg-hover",
    actionTitle: "font-semibold",
    actionDescription: "text-sm leading-relaxed text-muted-foreground",
    projectList: "m-0 grid list-none gap-2 p-0",
    projectItem: "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-xl border border-muted-border bg-surface p-4 shadow-xs max-[36rem]:grid-cols-1",
    projectCopy: "grid min-w-0 gap-1 [&_strong]:truncate [&_span]:truncate [&_span]:text-xs [&_span]:text-muted-foreground",
    projectLink: "inline-flex min-h-9 shrink-0 items-center justify-center rounded-md border border-primary bg-primary px-3 text-sm font-medium text-on-primary no-underline hover:bg-primary-strong max-[36rem]:w-full"
  }
});

export default async function DashboardPage() {
  try {
    const client = await createServerApiClient();
    const result = await getCurrentWorkspaces(client);
    const workspaces = result.data.workspaces.slice(0, 6);
    const primaryWorkspace = workspaces[0];
    const projectResults = await Promise.allSettled(workspaces.map(async (workspace) => ({
      workspace,
      projects: (await listProjects(client, {
        owner: { ownerType: workspace.ownerType, ownerId: workspace.ownerId },
        pageSize: 5,
        state: "active"
      })).data.items
    })));
    const hasProjectData = workspaces.length === 0 || projectResults.some((item) => item.status === "fulfilled");
    const recentProjects = projectResults.flatMap((item) => item.status === "fulfilled"
      ? item.value.projects.map((project) => ({ project, workspace: item.value.workspace }))
      : []).sort((left, right) => Date.parse(right.project.updatedAt) - Date.parse(left.project.updatedAt)).slice(0, 6);
    const styles = dashboardStyles();

    return (
      <main id="main-content" className={styles.root()} tabIndex={-1}>
        <PageHeader
          eyebrow="오늘의 작업"
          title="대시보드"
          description="최근 작업 범위를 선택하고 프로젝트 개발을 이어가세요. 설정과 자원 관리는 각 범위에서 분리됩니다."
          actions={primaryWorkspace === undefined ? (
            <Link className={styles.primaryAction()} href="/workspaces/new">워크스페이스 시작하기</Link>
          ) : (
            <Link className={styles.primaryAction()} href={`/workspaces/${encodeURIComponent(primaryWorkspace.storageScopeId)}/projects`}>
              프로젝트로 이동
            </Link>
          )}
        />

        <section className={styles.section()} aria-labelledby="dashboard-projects-title">
          <header className={styles.sectionHeader()}>
            <div className={styles.sectionCopy()}>
              <h2 className={styles.sectionTitle()} id="dashboard-projects-title">최근 프로젝트</h2>
              <p className={styles.sectionDescription()}>마지막으로 변경된 프로젝트를 Studio에서 바로 이어서 작업합니다.</p>
            </div>
            {primaryWorkspace === undefined ? null : <Link className={styles.textLink()} href={`/workspaces/${encodeURIComponent(primaryWorkspace.storageScopeId)}/projects`}>프로젝트 전체 보기</Link>}
          </header>
          {!hasProjectData ? (
            <div className={styles.empty()} role="status">
              <h3 className={styles.emptyTitle()}>최근 프로젝트를 불러오지 못했습니다</h3>
              <p className={styles.emptyDescription()}>워크스페이스는 사용할 수 있습니다. 해당 워크스페이스에서 프로젝트 목록을 다시 확인하세요.</p>
              <Link className={styles.primaryAction()} href="/workspaces">워크스페이스 선택</Link>
            </div>
          ) : recentProjects.length === 0 ? (
            <div className={styles.empty()}>
              <h3 className={styles.emptyTitle()}>아직 시작한 프로젝트가 없습니다</h3>
              <p className={styles.emptyDescription()}>워크스페이스를 선택해 첫 프로젝트를 만들면 최근 작업이 이곳에 표시됩니다.</p>
              {primaryWorkspace === undefined ? null : <Link className={styles.primaryAction()} href={`/workspaces/${encodeURIComponent(primaryWorkspace.storageScopeId)}/projects/new`}>첫 프로젝트 만들기</Link>}
            </div>
          ) : (
            <ul className={styles.projectList()}>
              {recentProjects.map(({ project, workspace }) => <RecentProject key={project.id} project={project} workspace={workspace} styles={styles} />)}
            </ul>
          )}
        </section>

        <section className={styles.section()} aria-labelledby="dashboard-workspaces-title">
          <header className={styles.sectionHeader()}>
            <div className={styles.sectionCopy()}>
              <h2 className={styles.sectionTitle()} id="dashboard-workspaces-title">워크스페이스</h2>
              <p className={styles.sectionDescription()}>개인 또는 조직 범위를 선택하면 그 안의 프로젝트가 열립니다.</p>
            </div>
            <Link className={styles.textLink()} href="/workspaces">전체 워크스페이스 보기</Link>
          </header>
          {workspaces.length === 0 ? (
            <div className={styles.empty()}>
              <h3 className={styles.emptyTitle()}>사용할 수 있는 워크스페이스가 없습니다</h3>
              <p className={styles.emptyDescription()}>개인 워크스페이스 상태를 다시 확인하거나 팀 워크스페이스를 만들어 시작하세요.</p>
              <Link className={styles.primaryAction()} href="/workspaces/new">워크스페이스 시작하기</Link>
            </div>
          ) : (
            <div className={styles.workspaceGrid()}>
              {workspaces.map((workspace) => (
                <Link className={styles.workspaceCard()} href={`/workspaces/${encodeURIComponent(workspace.storageScopeId)}/projects`} key={workspace.storageScopeId}>
                  <span className={styles.workspaceCopy()}>
                    <Badge size="sm" tone="neutral" variant="status">{workspaceOwnerLabel(workspace)}</Badge>
                    <strong className={styles.workspaceTitle()}>{workspace.displayLabel}</strong>
                    <span className={styles.workspaceDescription()}>프로젝트 목록과 최근 작업을 확인합니다.</span>
                  </span>
                  <span className={styles.workspaceAction()}>프로젝트 보기 <span aria-hidden="true">→</span></span>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className={styles.section()} aria-labelledby="dashboard-attention-title">
          <header className={styles.sectionCopy()}>
            <h2 className={styles.sectionTitle()} id="dashboard-attention-title">내 활동과 설정</h2>
            <p className={styles.sectionDescription()}>프로젝트 범위 밖의 개인 알림과 계정 설정입니다.</p>
          </header>
          <div className={styles.actionGrid()}>
            <Link className={styles.actionCard()} href="/notifications">
              <span className={styles.actionTitle()}>알림함</span>
              <span className={styles.actionDescription()}>보안, 협업, 계정 변경 사항을 확인하고 처리합니다.</span>
            </Link>
            <Link className={styles.actionCard()} href="/account">
              <span className={styles.actionTitle()}>계정 설정</span>
              <span className={styles.actionDescription()}>보안, 로그인 연결, 개인 토큰과 수신 설정을 관리합니다.</span>
            </Link>
          </div>
        </section>
      </main>
    );
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return (
      <EntryUnavailable
        title="대시보드를 일시적으로 사용할 수 없습니다"
        description="작업 범위를 안전하게 불러오지 못했습니다. 데이터는 변경되지 않았습니다."
        reference={safeRequestReference(error)}
        retryHref="/dashboard"
      />
    );
  }
}

function RecentProject({ project, styles, workspace }: Readonly<{
  project: Project;
  styles: ReturnType<typeof dashboardStyles>;
  workspace: Workspace;
}>) {
  const base = `/workspaces/${encodeURIComponent(workspace.storageScopeId)}/projects/${encodeURIComponent(project.id)}`;
  return (
    <li className={styles.projectItem()}>
      <span className={styles.projectCopy()}>
        <strong>{project.name}</strong>
        <span>{workspace.displayLabel} · {project.slug} · {new Date(project.updatedAt).toLocaleDateString("ko-KR")}</span>
      </span>
      <Link className={styles.projectLink()} href={`${base}/studio`}>Studio 열기</Link>
    </li>
  );
}

