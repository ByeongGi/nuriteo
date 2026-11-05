"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { collaborationError, readCsrfCredential } from "@/lib/api/browser-security.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { reissueOrganizationInvitation, revokeOrganizationInvitation } from "@/services/organization-invitations/api.ts";

import type { OrganizationInvitation } from "@nuriteo/api-client";

type InvitationFilter = "all" | "pending";

export function useInvitationDirectory(invitations: readonly OrganizationInvitation[], organizationId: string) {
  const mutation = useExclusiveMutation();
  const router = useRouter();
  const [filter, setFilterState] = useState<InvitationFilter>("pending");
  const [oneTimeUrl, setOneTimeUrl] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const visibleInvitations = useMemo(() => invitations.filter((invitation) => filter === "all" || invitation.status === "pending"), [filter, invitations]);

  function setFilter(value: string) {
    setFilterState(value === "all" ? "all" : "pending");
  }

  async function reissue(invitation: OrganizationInvitation) {
    await mutation.run(async () => {
      setError(undefined); setStatus(undefined); setOneTimeUrl(undefined);
      try {
        const result = await reissueOrganizationInvitation(createBrowserApiClient(), { organizationId, invitationId: invitation.id, role: invitation.proposedRole }, { csrfToken: readCsrfCredential() });
        if (result.data.delivery === "email_queued") setStatus("새 초대 이메일을 전송 대기열에 추가했습니다.");
        else setOneTimeUrl(result.data.acceptUrl.consume());
      } catch (cause) { setError(collaborationError(cause, "organization-invitation-terminal")); }
    });
  }

  async function revoke(invitation: OrganizationInvitation) {
    await mutation.run(async () => {
      setError(undefined); setStatus(undefined); setOneTimeUrl(undefined);
      try {
        await revokeOrganizationInvitation(createBrowserApiClient(), { organizationId, invitationId: invitation.id }, { csrfToken: readCsrfCredential() });
        setStatus("초대를 취소했습니다.");
        router.refresh();
      } catch (cause) { setError(collaborationError(cause, "organization-invitation-terminal")); }
    });
  }

  return {
    error,
    filter,
    isPending: mutation.isPending,
    oneTimeUrl,
    reissue,
    revoke,
    setFilter,
    status,
    visibleInvitations
  };
}
