"use client";

import type { OrganizationMember } from "@nuriteo/api-client";
import Link from "next/link";
import { useDeferredValue, useMemo, useState } from "react";

import { memberManagementStyles } from "#src/app/(workspace)/workspaces/[workspaceId]/members/member-management.styles.ts";
import { WorkspaceSection } from "#src/app/(workspace)/workspaces/[workspaceId]/workspace-section.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { SelectField } from "#src/components/ui/field.tsx";
import { SearchField } from "#src/components/ui/search-field.tsx";

type RoleFilter = "all" | OrganizationMember["role"];

export function MemberDirectory({ canManage, currentUserId, members, organizationName, workspaceId }: Readonly<{ canManage: boolean; currentUserId: string; members: readonly OrganizationMember[]; organizationName: string; workspaceId: string }>) {
  const styles = memberManagementStyles();
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<RoleFilter>("all");
  const deferredQuery = useDeferredValue(query);
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/members`;
  const visibleMembers = useMemo(() => {
    const normalized = deferredQuery.trim().toLocaleLowerCase("ko-KR");
    return members.filter((member) => (role === "all" || member.role === role) && (normalized === "" || `${member.displayName} ${member.userId}`.toLocaleLowerCase("ko-KR").includes(normalized)));
  }, [deferredQuery, members, role]);

  return (
    <WorkspaceSection eyebrow={organizationName} title="멤버" description="워크스페이스에 참여 중인 멤버를 조회하고 찾습니다." actions={<><Button size="sm" render={<Link href={`${base}/export`} />}>내보내기</Button>{canManage ? <><Button size="sm" render={<Link href={`${base}/invitations`} />}>초대 내역</Button><Button size="sm" variant="primary" render={<Link href={`${base}/invite`} />}>멤버 초대</Button></> : null}</>}>
      <div className={styles.toolbar()}>
        <SearchField label="멤버 검색" placeholder="이름 또는 멤버 ID 검색" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        <SelectField label="역할 필터" labelHidden options={[{ value: "all", label: "모든 역할" }, { value: "owner", label: "소유자" }, { value: "member", label: "멤버" }]} value={role} onValueChange={(value) => setRole(value === "owner" || value === "member" ? value : "all")} />
      </div>
      <p className={styles.summary()} role="status">전체 {members.length}명 중 {visibleMembers.length}명</p>
      {visibleMembers.length === 0 ? <div className={styles.empty()}>조건에 맞는 멤버가 없습니다.</div> : <ul className={styles.list()} aria-busy={query !== deferredQuery} aria-label="워크스페이스 멤버">{visibleMembers.map((member) => <li className={styles.row()} key={member.userId}><div className={styles.identity()}><span className={styles.name()}>{member.displayName}{member.userId === currentUserId ? " (나)" : ""}</span><span className={styles.metadata()}>{member.userId}</span></div><span className={styles.role()}>{member.role === "owner" ? "소유자" : "멤버"}</span><Button size="sm" render={<Link href={`${base}/${encodeURIComponent(member.userId)}`} />}>상세 보기</Button></li>)}</ul>}
    </WorkspaceSection>
  );
}
