"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { memberRoleSchema } from "@/app/(workspace)/workspaces/[workspaceId]/members/[userId]/role/_schema/member-role.ts";
import { collaborationError, readCsrfCredential } from "@/lib/api/browser-security.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { changeOrganizationMemberRole } from "@/services/organizations/api.ts";

import type { OrganizationMember } from "@nuriteo/api-client";

export function useMemberRoleEditor(member: OrganizationMember, organizationId: string, workspaceId: string) {
  const mutation = useExclusiveMutation();
  const router = useRouter();
  const [role, setRoleState] = useState<OrganizationMember["role"]>(member.role);
  const [error, setError] = useState<string>();
  const detailHref = `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(member.userId)}`;

  function setRole(value: string) {
    setRoleState(value === "owner" ? "owner" : "member");
  }

  async function save() {
    const parsed = memberRoleSchema.safeParse({ role });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "입력값을 확인하세요.");
      return;
    }
    await mutation.run(async () => {
      setError(undefined);
      try {
        await changeOrganizationMemberRole(createBrowserApiClient(), { organizationId, userId: member.userId, role: parsed.data.role }, { csrfToken: readCsrfCredential() });
        router.push(detailHref);
      } catch (cause) { setError(collaborationError(cause, "organization-member")); }
    });
  }

  return {
    error,
    isPending: mutation.isPending,
    role,
    save,
    setRole
  };
}
