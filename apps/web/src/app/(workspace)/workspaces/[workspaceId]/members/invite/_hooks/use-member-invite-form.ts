"use client";

import { useState } from "react";

import { memberInviteSchema } from "@/app/(workspace)/workspaces/[workspaceId]/members/invite/_schema/member-invite.ts";
import { collaborationError, readCsrfCredential } from "@/lib/api/browser-security.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { issueOrganizationInvitation } from "@/services/organization-invitations/api.ts";

import type { FormEvent } from "react";

export function useMemberInviteForm(organizationId: string) {
  const mutation = useExclusiveMutation();
  const [oneTimeUrl, setOneTimeUrl] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const parsed = memberInviteSchema.safeParse({
      email: String(data.get("email") ?? ""),
      role: String(data.get("role") ?? "")
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "입력값을 확인하세요.");
      return;
    }
    await mutation.run(async () => {
      setError(undefined); setStatus(undefined); setOneTimeUrl(undefined);
      try {
        const result = await issueOrganizationInvitation(createBrowserApiClient(), { organizationId, email: parsed.data.email, role: parsed.data.role }, { csrfToken: readCsrfCredential() });
        if (result.data.delivery === "email_queued") setStatus("초대 이메일을 전송 대기열에 추가했습니다.");
        else setOneTimeUrl(result.data.acceptUrl.consume());
        form.reset();
      } catch (cause) { setError(collaborationError(cause, "organization-invitation-issue")); }
    });
  }

  return {
    error,
    handleSubmit,
    isPending: mutation.isPending,
    oneTimeUrl,
    status
  };
}
