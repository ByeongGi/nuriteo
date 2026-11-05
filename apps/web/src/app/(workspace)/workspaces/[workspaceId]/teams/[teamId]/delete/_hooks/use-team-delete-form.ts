"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { teamErrorMessage } from "@/app/(workspace)/workspaces/[workspaceId]/teams/_utils/team-error.ts";
import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { deleteTeam } from "@/services/teams/api.ts";

import type { Team } from "@nuriteo/api-client";

export function useTeamDeleteForm(organizationId: string, team: Team, teamEtag: string, workspaceId: string) {
  const mutation = useExclusiveMutation();
  const router = useRouter();
  const [error, setError] = useState<string>();
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/teams`;

  async function remove() {
    await mutation.run(async () => {
      setError(undefined);
      try {
        await deleteTeam(createBrowserApiClient(), { organizationId, teamId: team.id, etag: teamEtag }, { csrfToken: readCsrfCredential() });
        router.push(base);
      } catch (cause) { setError(teamErrorMessage(cause)); }
    });
  }

  return {
    error,
    isPending: mutation.isPending,
    remove
  };
}
