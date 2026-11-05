"use client";

import Link from "next/link";

import { useTeamCreateForm } from "@/app/(workspace)/workspaces/[workspaceId]/teams/new/_hooks/use-team-create-form.ts";
import { teamManagementStyles } from "@/app/(workspace)/workspaces/[workspaceId]/teams/_components/team-management.styles.ts";
import { WorkspacePanel, WorkspaceSection } from "@/app/(workspace)/workspaces/[workspaceId]/_components/workspace-section.tsx";
import { Button } from "@/components/ui/button.tsx";
import { TextField } from "@/components/ui/field.tsx";

export function TeamCreateForm({ organizationId, organizationName, workspaceId }: Readonly<{ organizationId: string; organizationName: string; workspaceId: string }>) {
  const styles = teamManagementStyles();
  const { error, handleSubmit, isPending } = useTeamCreateForm(organizationId, workspaceId);
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/teams`;
  return <WorkspaceSection eyebrow={organizationName} title="새 팀" description="워크스페이스에 새로운 협업 팀을 만듭니다." actions={<Button size="sm" render={<Link href={base} />}>팀 목록</Button>}>{error ? <p className={styles.error()} role="alert">{error}</p> : null}<WorkspacePanel title="팀 정보" description="팀 주소는 생성 후 변경할 수 없습니다."><form className={styles.form()} onSubmit={handleSubmit} aria-busy={isPending}><TextField label="팀 주소" name="slug" required pattern="[a-z0-9](?:[a-z0-9\\-]{0,61}[a-z0-9])?" maxLength={63} disabled={isPending} placeholder="platform" /><TextField label="팀 이름" name="displayName" required maxLength={200} disabled={isPending} placeholder="Platform" /><div className={styles.actions()}><Button type="submit" variant="primary" disabled={isPending}>팀 만들기</Button></div></form></WorkspacePanel></WorkspaceSection>;
}
