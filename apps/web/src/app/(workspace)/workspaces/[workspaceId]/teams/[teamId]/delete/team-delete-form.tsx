"use client";

import { deleteTeam } from "@nuriteo/api-client";
import type { Team } from "@nuriteo/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { teamErrorMessage } from "#src/app/(workspace)/workspaces/[workspaceId]/teams/team-error.ts";
import { teamManagementStyles } from "#src/app/(workspace)/workspaces/[workspaceId]/teams/team-management.styles.ts";
import { WorkspaceSection } from "#src/app/(workspace)/workspaces/[workspaceId]/workspace-section.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { TextField } from "#src/components/ui/field.tsx";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

export function TeamDeleteForm({ organizationId, organizationName, team, teamEtag, workspaceId }: Readonly<{ organizationId: string; organizationName: string; team: Team; teamEtag: string; workspaceId: string }>) {
  const styles = teamManagementStyles();
  const mutation = useExclusiveMutation();
  const router = useRouter();
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string>();
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/teams`;
  async function remove() {
    await mutation.run(async () => {
      setError(undefined);
      try {
        await deleteTeam(createBrowserApiClient(), { organizationId, teamId: team.id, etag: teamEtag }, { csrfToken: readCsrfCredential() });
        router.push(base); router.refresh();
      } catch (cause) { setError(teamErrorMessage(cause)); }
    });
  }
  return <WorkspaceSection eyebrow={organizationName} title="팀 삭제" description={`${team.displayName} 팀과 팀에 연결된 권한을 제거합니다.`} actions={<Button size="sm" render={<Link href={`${base}/${encodeURIComponent(team.id)}`} />}>취소</Button>}>{error ? <p className={styles.error()} role="alert">{error}</p> : null}<section className={styles.danger()}><h2 className="m-0 text-base">팀을 삭제할까요?</h2><p className="m-0 text-sm text-muted-foreground">팀 멤버십과 프로젝트 역할이 제거됩니다. 프로젝트 자체는 삭제되지 않습니다.</p><TextField label={<>확인하려면 <strong>{team.slug}</strong> 입력</>} value={confirmation} onChange={(event) => setConfirmation(event.currentTarget.value)} autoComplete="off" spellCheck={false} disabled={mutation.isPending} /><div className={styles.actions()}><Button type="button" variant="danger" disabled={mutation.isPending || confirmation !== team.slug} onClick={() => void remove()}>팀 삭제</Button></div></section></WorkspaceSection>;
}
