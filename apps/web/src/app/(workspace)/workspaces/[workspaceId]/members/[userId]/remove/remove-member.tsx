"use client";

import { removeOrganizationMember } from "@nuriteo/api-client";
import type { OrganizationMember } from "@nuriteo/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { memberManagementStyles } from "#src/app/(workspace)/workspaces/[workspaceId]/members/member-management.styles.ts";
import { WorkspaceSection } from "#src/app/(workspace)/workspaces/[workspaceId]/workspace-section.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { collaborationError, readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

export function RemoveMember({ member, organizationId, organizationName, workspaceId }: Readonly<{ member: OrganizationMember; organizationId: string; organizationName: string; workspaceId: string }>) {
  const styles = memberManagementStyles();
  const mutation = useExclusiveMutation();
  const router = useRouter();
  const [error, setError] = useState<string>();
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/members`;
  const detailHref = `${base}/${encodeURIComponent(member.userId)}`;
  async function remove() {
    await mutation.run(async () => {
      setError(undefined);
      try {
        await removeOrganizationMember(createBrowserApiClient(), { organizationId, userId: member.userId }, { csrfToken: readCsrfCredential() });
        router.push(base); router.refresh();
      } catch (cause) { setError(collaborationError(cause, "organization-member")); }
    });
  }
  return <WorkspaceSection eyebrow={organizationName} title="워크스페이스에서 제외" description={`${member.displayName} 멤버의 접근 권한을 제거합니다.`} actions={<Button size="sm" render={<Link href={detailHref} />}>취소</Button>}>{error ? <p className={styles.error()} role="alert">{error}</p> : null}<section className={styles.danger()}><h2 className="m-0 text-base">{member.displayName} 님을 제외할까요?</h2><p className={styles.panelCopy()}>이 멤버는 워크스페이스와 공유 프로젝트에 더 이상 접근할 수 없습니다. 다시 참여하려면 새 초대가 필요합니다.</p><div className={styles.actions()}><Button type="button" variant="danger" disabled={mutation.isPending} onClick={() => void remove()}>멤버 제외</Button></div></section></WorkspaceSection>;
}
