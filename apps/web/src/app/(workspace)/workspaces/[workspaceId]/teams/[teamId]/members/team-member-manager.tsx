"use client";

import { addTeamMember, changeTeamMemberRole, removeTeamMember } from "@nuriteo/api-client";
import type { OrganizationMember, Team, TeamMember, TeamRole } from "@nuriteo/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDeferredValue, useMemo, useState } from "react";
import type { FormEvent } from "react";

import { teamErrorMessage, teamMemberEtag } from "#src/app/(workspace)/workspaces/[workspaceId]/teams/team-error.ts";
import { teamManagementStyles } from "#src/app/(workspace)/workspaces/[workspaceId]/teams/team-management.styles.ts";
import { WorkspacePanel, WorkspaceSection } from "#src/app/(workspace)/workspaces/[workspaceId]/workspace-section.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { SelectField } from "#src/components/ui/field.tsx";
import { SearchField } from "#src/components/ui/search-field.tsx";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

export function TeamMemberManager({ canManage, currentUserId, members, organizationId, organizationMembers, organizationName, team, workspaceId }: Readonly<{ canManage: boolean; currentUserId: string; members: readonly TeamMember[]; organizationId: string; organizationMembers: readonly OrganizationMember[]; organizationName: string; team: Team; workspaceId: string }>) {
  const styles = teamManagementStyles();
  const mutation = useExclusiveMutation();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const deferredQuery = useDeferredValue(query);
  const detail = `/workspaces/${encodeURIComponent(workspaceId)}/teams/${encodeURIComponent(team.id)}`;
  const memberById = useMemo(() => new Map(organizationMembers.map((member) => [member.userId, member] as const)), [organizationMembers]);
  const availableMembers = organizationMembers.filter((candidate) => !members.some((member) => member.userId === candidate.userId));
  const visibleMembers = useMemo(() => {
    const normalized = deferredQuery.trim().toLocaleLowerCase("ko-KR");
    return normalized === "" ? members : members.filter((member) => `${memberById.get(member.userId)?.displayName ?? ""} ${member.role} ${member.userId}`.toLocaleLowerCase("ko-KR").includes(normalized));
  }, [deferredQuery, memberById, members]);

  async function run(action: () => Promise<void>, message: string) {
    await mutation.run(async () => {
      setError(undefined); setStatus(undefined);
      try { await action(); setStatus(message); router.refresh(); } catch (cause) { setError(teamErrorMessage(cause)); }
    });
  }
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await run(async () => { await addTeamMember(createBrowserApiClient(), { organizationId, teamId: team.id, userId: String(data.get("userId") ?? ""), role: teamRole(data.get("role")) }, { csrfToken: readCsrfCredential() }); }, "팀 멤버를 추가했습니다.");
  }
  async function changeRole(member: TeamMember, role: TeamRole) {
    if (member.role === role) return;
    await run(async () => { await changeTeamMemberRole(createBrowserApiClient(), { organizationId, teamId: team.id, userId: member.userId, etag: teamMemberEtag(member.version), role }, { csrfToken: readCsrfCredential() }); }, "팀 멤버 역할을 저장했습니다.");
  }
  async function remove(member: TeamMember) {
    await run(async () => { await removeTeamMember(createBrowserApiClient(), { organizationId, teamId: team.id, userId: member.userId, etag: teamMemberEtag(member.version) }, { csrfToken: readCsrfCredential() }); }, "팀에서 멤버를 제외했습니다.");
  }

  return <WorkspaceSection eyebrow={organizationName} title="팀 멤버" description={`${team.displayName} 팀의 멤버와 팀 역할을 관리합니다.`} actions={<Button size="sm" render={<Link href={detail} />}>팀 개요</Button>}>
    {status ? <p className={styles.feedback()} role="status">{status}</p> : null}{error ? <p className={styles.error()} role="alert">{error}</p> : null}
    {canManage ? <WorkspacePanel title="멤버 추가" description="워크스페이스 멤버에게 팀 역할을 부여합니다."><form className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(9rem,.4fr)_auto]" onSubmit={add} aria-busy={mutation.isPending}><SelectField label="워크스페이스 멤버" name="userId" required disabled={mutation.isPending || availableMembers.length === 0} placeholder="멤버 선택" options={availableMembers.map((member) => ({ value: member.userId, label: member.displayName }))} /><SelectField label="팀 역할" name="role" defaultValue="member" disabled={mutation.isPending} options={[{ value: "member", label: "멤버" }, { value: "maintainer", label: "유지관리자" }]} /><Button type="submit" disabled={mutation.isPending || availableMembers.length === 0}>멤버 추가</Button></form></WorkspacePanel> : null}
    <div className={styles.toolbar()}><SearchField label="팀 멤버 검색" placeholder="이름, 역할 또는 멤버 ID 검색" value={query} onChange={(event) => setQuery(event.currentTarget.value)} /></div><p className={styles.summary()} role="status">전체 {members.length}명 중 {visibleMembers.length}명</p>
    {visibleMembers.length === 0 ? <div className={styles.empty()}>{members.length === 0 ? "이 팀에는 아직 멤버가 없습니다." : "검색 결과가 없습니다."}</div> : <ul className={styles.list()} aria-label="팀 멤버">{visibleMembers.map((member) => { const person = memberById.get(member.userId); const label = person?.displayName ?? member.userId; return <li className={styles.row()} key={member.userId}><div className={styles.identity()}><span className={styles.name()}>{label}{member.userId === currentUserId ? " (나)" : ""}</span><span className={styles.metadata()}>{member.userId}</span></div>{canManage ? <div className={styles.actions()}><SelectField label={`${label} 팀 역할`} labelHidden density="compact" value={member.role} disabled={mutation.isPending} options={[{ value: "member", label: "멤버" }, { value: "maintainer", label: "유지관리자" }]} onValueChange={(value) => void changeRole(member, teamRole(value))} /><Button size="sm" disabled={mutation.isPending || member.userId === currentUserId} onClick={() => void remove(member)}>제외</Button></div> : <span className={styles.badge()}>{member.role === "maintainer" ? "유지관리자" : "멤버"}</span>}</li>; })}</ul>}
  </WorkspaceSection>;
}

function teamRole(value: FormDataEntryValue | string | null): TeamRole { return value === "maintainer" ? "maintainer" : "member"; }
