"use client";

import { createTeam } from "@nuriteo/api-client";
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

export function TeamCreateForm({ organizationId, organizationName, workspaceId }: Readonly<{ organizationId: string; organizationName: string; workspaceId: string }>) {
  const styles = teamManagementStyles();
  const mutation = useExclusiveMutation();
  const router = useRouter();
  const [error, setError] = useState<string>();
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/teams`;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await mutation.run(async () => {
      setError(undefined);
      try {
        const result = await createTeam(createBrowserApiClient(), { organizationId, slug: String(data.get("slug") ?? ""), displayName: String(data.get("displayName") ?? "") }, { csrfToken: readCsrfCredential() });
        router.push(`${base}/${encodeURIComponent(result.data.id)}`);
        router.refresh();
      } catch (cause) { setError(teamErrorMessage(cause)); }
    });
  }
  return <WorkspaceSection eyebrow={organizationName} title="새 팀" description="워크스페이스에 새로운 협업 팀을 만듭니다." actions={<Button size="sm" render={<Link href={base} />}>팀 목록</Button>}>{error ? <p className={styles.error()} role="alert">{error}</p> : null}<WorkspacePanel title="팀 정보" description="팀 주소는 생성 후 변경할 수 없습니다."><form className={styles.form()} onSubmit={submit} aria-busy={mutation.isPending}><TextField label="팀 주소" name="slug" required pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" maxLength={63} disabled={mutation.isPending} placeholder="platform" /><TextField label="팀 이름" name="displayName" required maxLength={200} disabled={mutation.isPending} placeholder="Platform" /><div className={styles.actions()}><Button type="submit" variant="primary" disabled={mutation.isPending}>팀 만들기</Button></div></form></WorkspacePanel></WorkspaceSection>;
}
