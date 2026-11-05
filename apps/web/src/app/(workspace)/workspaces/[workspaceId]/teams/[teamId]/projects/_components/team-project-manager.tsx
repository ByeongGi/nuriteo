"use client";

import type { Project, ProjectRole, Team, TeamProjectRole } from "@nuriteo/api-client";
import Link from "next/link";

import { useTeamProjectManager } from "@/app/(workspace)/workspaces/[workspaceId]/teams/[teamId]/projects/_hooks/use-team-project-manager.ts";
import { teamManagementStyles } from "@/app/(workspace)/workspaces/[workspaceId]/teams/_components/team-management.styles.ts";
import { WorkspacePanel, WorkspaceSection } from "@/app/(workspace)/workspaces/[workspaceId]/_components/workspace-section.tsx";
import { Button } from "@/components/ui/button.tsx";
import { SelectField } from "@/components/ui/field.tsx";
import { SearchField } from "@/components/ui/search-field.tsx";

export function TeamProjectManager({ canManage, grants, organizationId, organizationName, projects, team, workspaceId }: Readonly<{ canManage: boolean; grants: readonly TeamProjectRole[]; organizationId: string; organizationName: string; projects: readonly Project[]; team: Team; workspaceId: string }>) {
  const styles = teamManagementStyles();
  const { add, availableProjects, changeRole, error, isPending, projectById, query, remove, setQuery, status, visibleGrants } = useTeamProjectManager({ grants, organizationId, projects, team });
  const detail = `/workspaces/${encodeURIComponent(workspaceId)}/teams/${encodeURIComponent(team.id)}`;
  return <WorkspaceSection eyebrow={organizationName} title="프로젝트 접근" description={`${team.displayName} 팀에 연결된 프로젝트 역할을 관리합니다.`} actions={<Button size="sm" render={<Link href={detail} />}>팀 개요</Button>}>
    {status ? <p className={styles.feedback()} role="status">{status}</p> : null}{error ? <p className={styles.error()} role="alert">{error}</p> : null}
    {canManage ? <WorkspacePanel title="프로젝트 연결" description="팀이 접근할 프로젝트와 역할을 선택합니다."><form className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,.35fr)_auto]" onSubmit={add} aria-busy={isPending}><SelectField label="프로젝트" name="projectId" required disabled={isPending || availableProjects.length === 0} placeholder="프로젝트 선택" options={availableProjects.map((project) => ({ value: project.id, label: `${project.name} · ${project.slug}` }))} /><SelectField label="프로젝트 역할" name="role" defaultValue="read" disabled={isPending} options={[{ value: "read", label: "읽기" }, { value: "write", label: "쓰기" }, { value: "admin", label: "관리" }]} /><Button type="submit" disabled={isPending || availableProjects.length === 0}>접근 권한 부여</Button></form></WorkspacePanel> : null}
    <div className={styles.toolbar()}><SearchField label="프로젝트 권한 검색" placeholder="프로젝트 이름, 슬러그 또는 역할 검색" value={query} onChange={(event) => setQuery(event.currentTarget.value)} /></div><p className={styles.summary()} role="status">전체 {grants.length}개 중 {visibleGrants.length}개</p>
    {visibleGrants.length === 0 ? <div className={styles.empty()}>{(function () {
    if (grants.length === 0) {
        return ("이 팀에 연결된 프로젝트가 없습니다.");
    }
    return ("검색 결과가 없습니다.");
})()}</div> : <ul className={styles.list()} aria-label="팀 프로젝트 역할">{visibleGrants.map((grant) => { const project = projectById.get(grant.projectId); const label = project?.name ?? grant.projectId; return <li className={styles.row()} key={grant.projectId}><div className={styles.identity()}><span className={styles.name()}>{label}</span><span className={styles.metadata()}>{project?.slug ?? grant.projectId}</span></div>{(function () {
    if (canManage) {
        return (<div className={styles.actions()}><SelectField label={`${label} 프로젝트 역할`} labelHidden density="compact" value={grant.role} disabled={isPending} options={[{ value: "read", label: "읽기" }, { value: "write", label: "쓰기" }, { value: "admin", label: "관리" }]} onValueChange={(value) => void changeRole(grant, value)} /><Button size="sm" disabled={isPending} onClick={() => void remove(grant)}>제거</Button></div>);
    }
    return (<span className={styles.badge()}>{projectRoleLabel(grant.role)}</span>);
})()}</li>; })}</ul>}
  </WorkspaceSection>;
}

function projectRoleLabel(role: ProjectRole): string {
  if (role === "admin") {
    return "관리";
  }

  if (role === "write") {
    return "쓰기";
  }

  return "읽기";
}
