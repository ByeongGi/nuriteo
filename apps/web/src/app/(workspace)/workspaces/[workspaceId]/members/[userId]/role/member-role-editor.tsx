"use client";

import { changeOrganizationMemberRole } from "@nuriteo/api-client";
import type { OrganizationMember } from "@nuriteo/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { memberManagementStyles } from "#src/app/(workspace)/workspaces/[workspaceId]/members/member-management.styles.ts";
import { WorkspacePanel, WorkspaceSection } from "#src/app/(workspace)/workspaces/[workspaceId]/workspace-section.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { SelectField } from "#src/components/ui/field.tsx";
import { collaborationError, readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

export function MemberRoleEditor({ member, organizationId, organizationName, workspaceId }: Readonly<{ member: OrganizationMember; organizationId: string; organizationName: string; workspaceId: string }>) {
  const styles = memberManagementStyles();
  const mutation = useExclusiveMutation();
  const router = useRouter();
  const [role, setRole] = useState<OrganizationMember["role"]>(member.role);
  const [error, setError] = useState<string>();
  const detailHref = `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(member.userId)}`;
  async function save() {
    await mutation.run(async () => {
      setError(undefined);
      try {
        await changeOrganizationMemberRole(createBrowserApiClient(), { organizationId, userId: member.userId, role }, { csrfToken: readCsrfCredential() });
        router.push(detailHref); router.refresh();
      } catch (cause) { setError(collaborationError(cause, "organization-member")); }
    });
  }
  return <WorkspaceSection eyebrow={organizationName} title="역할 변경" description={`${member.displayName} 멤버의 워크스페이스 역할을 변경합니다.`} actions={<Button size="sm" render={<Link href={detailHref} />}>상세로 돌아가기</Button>}>{error ? <p className={styles.error()} role="alert">{error}</p> : null}<WorkspacePanel title="새 역할" description="소유자는 멤버와 워크스페이스 관리 권한을 가집니다."><div className={styles.form()}><SelectField label="역할" options={[{ value: "member", label: "멤버" }, { value: "owner", label: "소유자" }]} value={role} onValueChange={(value) => setRole(value === "owner" ? "owner" : "member")} disabled={mutation.isPending} /><div className={styles.actions()}><Button type="button" variant="primary" disabled={mutation.isPending || role === member.role} onClick={() => void save()}>역할 저장</Button></div></div></WorkspacePanel></WorkspaceSection>;
}
