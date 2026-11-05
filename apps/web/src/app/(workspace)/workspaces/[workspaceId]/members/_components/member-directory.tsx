"use client";

import type { OrganizationMember } from "@nuriteo/api-client";
import Link from "next/link";

import { useMemberDirectory } from "@/app/(workspace)/workspaces/[workspaceId]/members/_hooks/use-member-directory.ts";
import { memberManagementStyles } from "@/app/(workspace)/workspaces/[workspaceId]/members/_components/member-management.styles.ts";
import { WorkspaceSection } from "@/app/(workspace)/workspaces/[workspaceId]/_components/workspace-section.tsx";
import { Button } from "@/components/ui/button.tsx";
import { SelectField } from "@/components/ui/field.tsx";
import { SearchField } from "@/components/ui/search-field.tsx";

export function MemberDirectory({ canManage, currentUserId, members, organizationName, workspaceId }: Readonly<{ canManage: boolean; currentUserId: string; members: readonly OrganizationMember[]; organizationName: string; workspaceId: string }>) {
  const styles = memberManagementStyles();
  const { deferredQuery, query, role, setQuery, setRole, visibleMembers } = useMemberDirectory(members);
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/members`;

  return (
    <WorkspaceSection eyebrow={organizationName} title="멤버" description="워크스페이스에 참여 중인 멤버를 조회하고 찾습니다." actions={<><Button size="sm" render={<Link href={`${base}/export`} />}>내보내기</Button>{canManage ? <><Button size="sm" render={<Link href={`${base}/invitations`} />}>초대 내역</Button><Button size="sm" variant="primary" render={<Link href={`${base}/invite`} />}>멤버 초대</Button></> : null}</>}>
      <div className={styles.toolbar()}>
        <SearchField label="멤버 검색" placeholder="이름 또는 멤버 ID 검색" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        <SelectField label="역할 필터" labelHidden options={[{ value: "all", label: "모든 역할" }, { value: "owner", label: "소유자" }, { value: "member", label: "멤버" }]} value={role} onValueChange={setRole} />
      </div>
      <p className={styles.summary()} role="status">전체 {members.length}명 중 {visibleMembers.length}명</p>
      {visibleMembers.length === 0 ? <div className={styles.empty()}>조건에 맞는 멤버가 없습니다.</div> : <ul className={styles.list()} aria-busy={query !== deferredQuery} aria-label="워크스페이스 멤버">{visibleMembers.map((member) => <li className={styles.row()} key={member.userId}><div className={styles.identity()}><span className={styles.name()}>{member.displayName}{(function () {
    if (member.userId === currentUserId) {
        return (" (나)");
    }
    return ("");
})()}</span><span className={styles.metadata()}>{member.userId}</span></div><span className={styles.role()}>{(function () {
    if (member.role === "owner") {
        return ("소유자");
    }
    return ("멤버");
})()}</span><Button size="sm" render={<Link href={`${base}/${encodeURIComponent(member.userId)}`} />}>상세 보기</Button></li>)}</ul>}
    </WorkspaceSection>
  );
}
