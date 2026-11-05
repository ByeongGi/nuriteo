"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { teamCreateSchema } from "@/app/(workspace)/workspaces/[workspaceId]/teams/new/_schema/team-create.ts";
import { teamErrorMessage } from "@/app/(workspace)/workspaces/[workspaceId]/teams/_utils/team-error.ts";
import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { createTeam } from "@/services/teams/api.ts";

import type { FormEvent } from "react";

export function useTeamCreateForm(organizationId: string, workspaceId: string) {
  const mutation = useExclusiveMutation();
  const router = useRouter();
  const [error, setError] = useState<string>();
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/teams`;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = teamCreateSchema.safeParse({
      slug: String(data.get("slug") ?? ""),
      displayName: String(data.get("displayName") ?? "")
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "입력값을 확인하세요.");
      return;
    }
    await mutation.run(async () => {
      setError(undefined);
      try {
        const result = await createTeam(createBrowserApiClient(), { organizationId, slug: parsed.data.slug, displayName: parsed.data.displayName }, { csrfToken: readCsrfCredential() });
        router.push(`${base}/${encodeURIComponent(result.data.id)}`);
      } catch (cause) { setError(teamErrorMessage(cause)); }
    });
  }

  return {
    error,
    handleSubmit,
    isPending: mutation.isPending
  };
}
