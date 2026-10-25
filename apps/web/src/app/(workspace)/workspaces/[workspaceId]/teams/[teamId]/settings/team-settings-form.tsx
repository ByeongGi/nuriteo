"use client";

import { renameTeam } from "@nuriteo/api-client";
import type { Team } from "@nuriteo/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

import { teamErrorMessage } from "#src/app/(workspace)/workspaces/[workspaceId]/teams/team-error.ts";
import { teamManagementStyles } from "#src/app/(workspace)/workspaces/[workspaceId]/teams/team-management.styles.ts";
import { WorkspacePanel, WorkspaceSection } from "#src/app/(workspace)/workspaces/[workspaceId]/workspace-section.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { TextField } from "#src/components/ui/field.tsx";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

export function TeamSettingsForm({ organizationId, organizationName, team, teamEtag, workspaceId }: Readonly<{ organizationId: string; organizationName: string; team: Team; teamEtag: string; workspaceId: string }>) {
  const styles = teamManagementStyles();
  const mutation = useExclusiveMutation();
  const router = useRouter();
  const [error, setError] = useState<string>();
  const detail = `/workspaces/${encodeURIComponent(workspaceId)}/teams/${encodeURIComponent(team.id)}`;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const displayName = String(new FormData(event.currentTarget).get("displayName") ?? "");
    await mutation.run(async () => {
      setError(undefined);
      try {
        await renameTeam(createBrowserApiClient(), { organizationId, teamId: team.id, etag: teamEtag, displayName }, { csrfToken: readCsrfCredential() });
        router.push(detail);
      } catch (cause) { setError(teamErrorMessage(cause)); }
    });
  }
  return <WorkspaceSection eyebrow={organizationName} title="팀 설정" description={`${team.displayName} 팀의 표시 이름을 변경합니다.`} actions={<Button size="sm" render={<Link href={detail} />}>팀 개요</Button>}>{error ? <p className={styles.error()} role="alert">{error}</p> : null}<WorkspacePanel title="기본 정보" description={`팀 주소 ${team.slug}은 변경되지 않습니다.`}><form className={styles.form()} onSubmit={submit} aria-busy={mutation.isPending}><TextField label="팀 이름" name="displayName" defaultValue={team.displayName} required maxLength={200} disabled={mutation.isPending} /><div className={styles.actions()}><Button type="submit" variant="primary" disabled={mutation.isPending}>이름 저장</Button></div></form></WorkspacePanel></WorkspaceSection>;
}
