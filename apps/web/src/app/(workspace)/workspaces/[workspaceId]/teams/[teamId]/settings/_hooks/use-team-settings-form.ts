"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { teamSettingsSchema } from "@/app/(workspace)/workspaces/[workspaceId]/teams/[teamId]/settings/_schema/team-settings.ts";
import { teamErrorMessage } from "@/app/(workspace)/workspaces/[workspaceId]/teams/_utils/team-error.ts";
import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { renameTeam } from "@/services/teams/api.ts";

import type { FormEvent } from "react";
import type { Team } from "@nuriteo/api-client";

export function useTeamSettingsForm(organizationId: string, team: Team, teamEtag: string, workspaceId: string) {
  const mutation = useExclusiveMutation();
  const router = useRouter();
  const [error, setError] = useState<string>();
  const detail = `/workspaces/${encodeURIComponent(workspaceId)}/teams/${encodeURIComponent(team.id)}`;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = teamSettingsSchema.safeParse({
      displayName: String(new FormData(event.currentTarget).get("displayName") ?? "")
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "입력값을 확인하세요.");
      return;
    }
    await mutation.run(async () => {
      setError(undefined);
      try {
        await renameTeam(createBrowserApiClient(), { organizationId, teamId: team.id, etag: teamEtag, displayName: parsed.data.displayName }, { csrfToken: readCsrfCredential() });
        router.push(detail);
      } catch (cause) { setError(teamErrorMessage(cause)); }
    });
  }

  return {
    error,
    handleSubmit,
    isPending: mutation.isPending
  };
}
