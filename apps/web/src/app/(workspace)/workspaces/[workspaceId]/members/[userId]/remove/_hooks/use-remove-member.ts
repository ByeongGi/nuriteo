"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { collaborationError, readCsrfCredential } from "@/lib/api/browser-security.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { removeOrganizationMember } from "@/services/organizations/api.ts";

import type { OrganizationMember } from "@nuriteo/api-client";

export function useRemoveMember(member: OrganizationMember, organizationId: string, workspaceId: string) {
  const mutation = useExclusiveMutation();
  const router = useRouter();
  const [error, setError] = useState<string>();
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/members`;

  async function remove() {
    await mutation.run(async () => {
      setError(undefined);
      try {
        await removeOrganizationMember(createBrowserApiClient(), { organizationId, userId: member.userId }, { csrfToken: readCsrfCredential() });
        router.push(base);
      } catch (cause) { setError(collaborationError(cause, "organization-member")); }
    });
  }

  return {
    error,
    isPending: mutation.isPending,
    remove
  };
}
