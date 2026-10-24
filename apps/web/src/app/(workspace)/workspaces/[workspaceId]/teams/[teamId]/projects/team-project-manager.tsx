"use client";

import { addTeamProjectRole, changeTeamProjectRole, removeTeamProjectRole } from "@nuriteo/api-client";
import type { Project, ProjectRole, Team, TeamProjectRole } from "@nuriteo/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDeferredValue, useMemo, useState } from "react";
import type { FormEvent } from "react";

import { teamErrorMessage, teamProjectRoleEtag } from "#src/app/(workspace)/workspaces/[workspaceId]/teams/team-error.ts";
import { teamManagementStyles } from "#src/app/(workspace)/workspaces/[workspaceId]/teams/team-management.styles.ts";
import { WorkspacePanel, WorkspaceSection } from "#src/app/(workspace)/workspaces/[workspaceId]/workspace-section.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { SelectField } from "#src/components/ui/field.tsx";
import { SearchField } from "#src/components/ui/search-field.tsx";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

export function TeamProjectManager({ canManage, grants, organizationId, organizationName, projects, team, workspaceId }: Readonly<{ canManage: boolean; grants: readonly TeamProjectRole[]; organizationId: string; organizationName: string; projects: readonly Project[]; team: Team; workspaceId: string }>) {
  const styles = teamManagementStyles();
  const mutation = useExclusiveMutation();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const deferredQuery = useDeferredValue(query);
  const detail = `/workspaces/${encodeURIComponent(workspaceId)}/teams/${encodeURIComponent(team.id)}`;
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project] as const)), [projects]);
  const availableProjects = projects.filter((project) => !grants.some((grant) => grant.projectId === project.id));
  const visibleGrants = useMemo(() => { const normalized = deferredQuery.trim().toLocaleLowerCase("ko-KR"); return normalized === "" ? grants : grants.filter((grant) => { const project = projectById.get(grant.projectId); return `${project?.name ?? ""} ${project?.slug ?? ""} ${grant.role}`.toLocaleLowerCase("ko-KR").includes(normalized); }); }, [deferredQuery, grants, projectById]);
  async function run(action: () => Promise<void>, message: string) { await mutation.run(async () => { setError(undefined); setStatus(undefined); try { await action(); setStatus(message); router.refresh(); } catch (cause) { setError(teamErrorMessage(cause)); } }); }
  async function add(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); await run(async () => { await addTeamProjectRole(createBrowserApiClient(), { organizationId, teamId: team.id, projectId: String(data.get("projectId") ?? ""), role: projectRole(data.get("role")) }, { csrfToken: readCsrfCredential() }); }, "프로젝트 접근 권한을 부여했습니다."); }
  async function changeRole(grant: TeamProjectRole, role: ProjectRole) { if (grant.role === role) return; await run(async () => { await changeTeamProjectRole(createBrowserApiClient(), { organizationId, teamId: team.id, projectId: grant.projectId, etag: teamProjectRoleEtag(grant.version), role }, { csrfToken: readCsrfCredential() }); }, "프로젝트 역할을 저장했습니다."); }
  async function remove(grant: TeamProjectRole) { await run(async () => { await removeTeamProjectRole(createBrowserApiClient(), { organizationId, teamId: team.id, projectId: grant.projectId, etag: teamProjectRoleEtag(grant.version) }, { csrfToken: readCsrfCredential() }); }, "프로젝트 접근 권한을 제거했습니다."); }
  return <WorkspaceSection eyebrow={organizationName} title="프로젝트 접근" description={`${team.displayName} 팀에 연결된 프로젝트 역할을 관리합니다.`} actions={<Button size="sm" render={<Link href={detail} />}>팀 개요</Button>}>
    {status ? <p className={styles.feedback()} role="status">{status}</p> : null}{error ? <p className={styles.error()} role="alert">{error}</p> : null}
    {canManage ? <WorkspacePanel title="프로젝트 연결" description="팀이 접근할 프로젝트와 역할을 선택합니다."><form className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,.35fr)_auto]" onSubmit={add} aria-busy={mutation.isPending}><SelectField label="프로젝트" name="projectId" required disabled={mutation.isPending || availableProjects.length === 0} placeholder="프로젝트 선택" options={availableProjects.map((project) => ({ value: project.id, label: `${project.name} · ${project.slug}` }))} /><SelectField label="프로젝트 역할" name="role" defaultValue="read" disabled={mutation.isPending} options={[{ value: "read", label: "읽기" }, { value: "write", label: "쓰기" }, { value: "admin", label: "관리" }]} /><Button type="submit" disabled={mutation.isPending || availableProjects.length === 0}>접근 권한 부여</Button></form></WorkspacePanel> : null}
    <div className={styles.toolbar()}><SearchField label="프로젝트 권한 검색" placeholder="프로젝트 이름, 슬러그 또는 역할 검색" value={query} onChange={(event) => setQuery(event.currentTarget.value)} /></div><p className={styles.summary()} role="status">전체 {grants.length}개 중 {visibleGrants.length}개</p>
    {visibleGrants.length === 0 ? <div className={styles.empty()}>{grants.length === 0 ? "이 팀에 연결된 프로젝트가 없습니다." : "검색 결과가 없습니다."}</div> : <ul className={styles.list()} aria-label="팀 프로젝트 역할">{visibleGrants.map((grant) => { const project = projectById.get(grant.projectId); const label = project?.name ?? grant.projectId; return <li className={styles.row()} key={grant.projectId}><div className={styles.identity()}><span className={styles.name()}>{label}</span><span className={styles.metadata()}>{project?.slug ?? grant.projectId}</span></div>{canManage ? <div className={styles.actions()}><SelectField label={`${label} 프로젝트 역할`} labelHidden density="compact" value={grant.role} disabled={mutation.isPending} options={[{ value: "read", label: "읽기" }, { value: "write", label: "쓰기" }, { value: "admin", label: "관리" }]} onValueChange={(value) => void changeRole(grant, projectRole(value))} /><Button size="sm" disabled={mutation.isPending} onClick={() => void remove(grant)}>제거</Button></div> : <span className={styles.badge()}>{projectRoleLabel(grant.role)}</span>}</li>; })}</ul>}
  </WorkspaceSection>;
}

function projectRole(value: FormDataEntryValue | string | null): ProjectRole {
  return value === "admin" || value === "write" ? value : "read";
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
