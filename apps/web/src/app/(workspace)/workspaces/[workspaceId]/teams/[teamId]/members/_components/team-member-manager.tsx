"use client";

import type { OrganizationMember, Team, TeamMember } from "@nuriteo/api-client";
import Link from "next/link";

import { useTeamMemberManager } from "@/app/(workspace)/workspaces/[workspaceId]/teams/[teamId]/members/_hooks/use-team-member-manager.ts";
import { teamManagementStyles } from "@/app/(workspace)/workspaces/[workspaceId]/teams/_components/team-management.styles.ts";
import { WorkspacePanel, WorkspaceSection } from "@/app/(workspace)/workspaces/[workspaceId]/_components/workspace-section.tsx";
import { Button } from "@/components/ui/button.tsx";
import { SelectField } from "@/components/ui/field.tsx";
import { SearchField } from "@/components/ui/search-field.tsx";

export function TeamMemberManager({ canManage, currentUserId, members, organizationId, organizationMembers, organizationName, team, workspaceId }: Readonly<{ canManage: boolean; currentUserId: string; members: readonly TeamMember[]; organizationId: string; organizationMembers: readonly OrganizationMember[]; organizationName: string; team: Team; workspaceId: string }>) {
  const styles = teamManagementStyles();
  const { add, availableMembers, changeRole, error, isPending, memberById, query, remove, setQuery, status, visibleMembers } = useTeamMemberManager({ members, organizationId, organizationMembers, team });
  const detail = `/workspaces/${encodeURIComponent(workspaceId)}/teams/${encodeURIComponent(team.id)}`;

  return <WorkspaceSection eyebrow={organizationName} title="팀 멤버" description={`${team.displayName} 팀의 멤버와 팀 역할을 관리합니다.`} actions={<Button size="sm" render={<Link href={detail} />}>팀 개요</Button>}>
    {status ? <p className={styles.feedback()} role="status">{status}</p> : null}{error ? <p className={styles.error()} role="alert">{error}</p> : null}
    {canManage ? <WorkspacePanel title="멤버 추가" description="워크스페이스 멤버에게 팀 역할을 부여합니다."><form className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(9rem,.4fr)_auto]" onSubmit={add} aria-busy={isPending}><SelectField label="워크스페이스 멤버" name="userId" required disabled={isPending || availableMembers.length === 0} placeholder="멤버 선택" options={availableMembers.map((member) => ({ value: member.userId, label: member.displayName }))} /><SelectField label="팀 역할" name="role" defaultValue="member" disabled={isPending} options={[{ value: "member", label: "멤버" }, { value: "maintainer", label: "유지관리자" }]} /><Button type="submit" disabled={isPending || availableMembers.length === 0}>멤버 추가</Button></form></WorkspacePanel> : null}
    <div className={styles.toolbar()}><SearchField label="팀 멤버 검색" placeholder="이름, 역할 또는 멤버 ID 검색" value={query} onChange={(event) => setQuery(event.currentTarget.value)} /></div><p className={styles.summary()} role="status">전체 {members.length}명 중 {visibleMembers.length}명</p>
    {visibleMembers.length === 0 ? <div className={styles.empty()}>{(function () {
    if (members.length === 0) {
        return ("이 팀에는 아직 멤버가 없습니다.");
    }
    return ("검색 결과가 없습니다.");
})()}</div> : <ul className={styles.list()} aria-label="팀 멤버">{visibleMembers.map((member) => { const person = memberById.get(member.userId); const label = person?.displayName ?? member.userId; return <li className={styles.row()} key={member.userId}><div className={styles.identity()}><span className={styles.name()}>{label}{(function () {
    if (member.userId === currentUserId) {
        return (" (나)");
    }
    return ("");
})()}</span><span className={styles.metadata()}>{member.userId}</span></div>{(function () {
    if (canManage) {
        return (<div className={styles.actions()}><SelectField label={`${label} 팀 역할`} labelHidden density="compact" value={member.role} disabled={isPending} options={[{ value: "member", label: "멤버" }, { value: "maintainer", label: "유지관리자" }]} onValueChange={(value) => void changeRole(member, value)} /><Button size="sm" disabled={isPending || member.userId === currentUserId} onClick={() => void remove(member)}>제외</Button></div>);
    }
    return (<span className={styles.badge()}>{(function () {
    if (member.role === "maintainer") {
        return ("유지관리자");
    }
    return ("멤버");
})()}</span>);
})()}</li>; })}</ul>}
  </WorkspaceSection>;
}
