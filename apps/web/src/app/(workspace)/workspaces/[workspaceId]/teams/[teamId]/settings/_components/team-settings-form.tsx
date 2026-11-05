"use client";

import type { Team } from "@nuriteo/api-client";
import Link from "next/link";

import { useTeamSettingsForm } from "@/app/(workspace)/workspaces/[workspaceId]/teams/[teamId]/settings/_hooks/use-team-settings-form.ts";
import { teamManagementStyles } from "@/app/(workspace)/workspaces/[workspaceId]/teams/_components/team-management.styles.ts";
import { WorkspacePanel, WorkspaceSection } from "@/app/(workspace)/workspaces/[workspaceId]/_components/workspace-section.tsx";
import { Button } from "@/components/ui/button.tsx";
import { TextField } from "@/components/ui/field.tsx";

export function TeamSettingsForm({ organizationId, organizationName, team, teamEtag, workspaceId }: Readonly<{ organizationId: string; organizationName: string; team: Team; teamEtag: string; workspaceId: string }>) {
  const styles = teamManagementStyles();
  const { error, handleSubmit, isPending } = useTeamSettingsForm(organizationId, team, teamEtag, workspaceId);
  const detail = `/workspaces/${encodeURIComponent(workspaceId)}/teams/${encodeURIComponent(team.id)}`;
  return <WorkspaceSection eyebrow={organizationName} title="팀 설정" description={`${team.displayName} 팀의 표시 이름을 변경합니다.`} actions={<Button size="sm" render={<Link href={detail} />}>팀 개요</Button>}>{error ? <p className={styles.error()} role="alert">{error}</p> : null}<WorkspacePanel title="기본 정보" description={`팀 주소 ${team.slug}은 변경되지 않습니다.`}><form className={styles.form()} onSubmit={handleSubmit} aria-busy={isPending}><TextField label="팀 이름" name="displayName" defaultValue={team.displayName} required maxLength={200} disabled={isPending} /><div className={styles.actions()}><Button type="submit" variant="primary" disabled={isPending}>이름 저장</Button></div></form></WorkspacePanel></WorkspaceSection>;
}
