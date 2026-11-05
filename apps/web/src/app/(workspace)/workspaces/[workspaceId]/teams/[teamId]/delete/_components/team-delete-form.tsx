"use client";

import type { Team } from "@nuriteo/api-client";
import Link from "next/link";

import { useTeamDeleteForm } from "@/app/(workspace)/workspaces/[workspaceId]/teams/[teamId]/delete/_hooks/use-team-delete-form.ts";
import { teamManagementStyles } from "@/app/(workspace)/workspaces/[workspaceId]/teams/_components/team-management.styles.ts";
import { WorkspaceSection } from "@/app/(workspace)/workspaces/[workspaceId]/_components/workspace-section.tsx";
import { Button } from "@/components/ui/button.tsx";

export function TeamDeleteForm({ organizationId, organizationName, team, teamEtag, workspaceId }: Readonly<{ organizationId: string; organizationName: string; team: Team; teamEtag: string; workspaceId: string }>) {
  const styles = teamManagementStyles();
  const { error, isPending, remove } = useTeamDeleteForm(organizationId, team, teamEtag, workspaceId);
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/teams`;
  return <WorkspaceSection eyebrow={organizationName} title="팀 삭제" description={`${team.displayName} 팀과 팀에 연결된 권한을 제거합니다.`} actions={<Button size="sm" render={<Link href={`${base}/${encodeURIComponent(team.id)}`} />}>취소</Button>}>{error ? <p className={styles.error()} role="alert">{error}</p> : null}<section className={styles.danger()}><h2 className="m-0 text-base">팀을 삭제할까요?</h2><p className="m-0 text-sm text-muted-foreground">팀 멤버십과 프로젝트 역할이 제거됩니다. 프로젝트 자체는 삭제되지 않으며 이 작업은 되돌릴 수 없습니다.</p><div className={styles.actions()}><Button type="button" variant="danger" disabled={isPending} onClick={() => void remove()}>팀 삭제</Button></div></section></WorkspaceSection>;
}
