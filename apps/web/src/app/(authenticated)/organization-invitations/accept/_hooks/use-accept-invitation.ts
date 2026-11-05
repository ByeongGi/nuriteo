"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { invitationTokenSchema } from "@/app/(authenticated)/organization-invitations/accept/_schema/invitation.ts";
import { collaborationError, readCsrfCredential } from "@/lib/api/browser-security.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { acceptInvitedOrganization, declineInvitedOrganization } from "@/services/organization-invitations/api.ts";

export function useAcceptInvitation() {
  const router = useRouter();
  const token = useSearchParams().get("token");
  const mutation = useExclusiveMutation();
  const [error, setError] = useState<string>();

  async function respond(action: "accept" | "decline") {
    const parsed = invitationTokenSchema.safeParse({ token: token ?? "" });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "초대 링크가 없거나 올바르지 않습니다.");
      return;
    }
    await mutation.run(async () => {
      setError(undefined);
      try {
        const client = createBrowserApiClient();
        const options = { csrfToken: readCsrfCredential() };
        if (action === "accept") await acceptInvitedOrganization(client, parsed.data.token, options);
        else await declineInvitedOrganization(client, parsed.data.token, options);
        router.replace(
          action === "accept"
            ? "/workspaces?joined=1"
            : "/workspaces?invitation=declined"
        );
        router.refresh();
      } catch (cause) {
        setError(collaborationError(cause, "organization-invitation-terminal"));
      }
    });
  }

  return {
    error,
    isPending: mutation.isPending,
    respond
  };
}
