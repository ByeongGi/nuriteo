import type { Metadata } from "next";
import Link from "next/link";
import { redirect, unstable_rethrow } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { teamManagementStyles } from "#src/app/(workspace)/workspaces/[workspaceId]/teams/team-management.styles.ts";
import { loadTeamContext } from "#src/app/(workspace)/workspaces/[workspaceId]/teams/team-page-data.ts";
import { WorkspaceFacts, WorkspacePanel, WorkspaceSection } from "#src/app/(workspace)/workspaces/[workspaceId]/workspace-section.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";

export const metadata: Metadata = { title: "팀 상세" };

export default async function TeamDetailPage({ params }: { readonly params: Promise<{ workspaceId: string; teamId: string }> }) {
  const { teamId, workspaceId } = await params;
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/teams`;
  try {
    const context = await loadTeamContext(workspaceId, teamId);
    const detail = `${base}/${encodeURIComponent(teamId)}`;
    const styles = teamManagementStyles();
    return <WorkspaceSection eyebrow={context.organization.displayName} title={context.team.displayName} description="팀의 구성과 연결된 접근 권한을 확인합니다." actions={<Button size="sm" render={<Link href={base} />}>팀 목록</Button>}>
      <WorkspacePanel title="팀 개요" description="각 관리 작업은 목적별 화면에서 수행합니다.">
        <WorkspaceFacts items={[{ label: "팀 주소", value: context.team.slug }, { label: "팀 멤버", value: `${context.members.length}명` }, { label: "프로젝트 연결", value: `${context.projectRoles.length}개` }, { label: "버전", value: `v${context.team.version}` }]} />
        <nav className={styles.navigation()} aria-label="팀 관리"><Button render={<Link href={`${detail}/members`} />}>멤버</Button><Button render={<Link href={`${detail}/projects`} />}>프로젝트 접근</Button>{context.canRenameTeam ? <Button render={<Link href={`${detail}/settings`} />}>팀 설정</Button> : null}{context.canDeleteTeam ? <Button render={<Link href={`${detail}/delete`} />}>팀 삭제</Button> : null}</nav>
      </WorkspacePanel>
    </WorkspaceSection>;
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return <EntryUnavailable title="팀 상세를 불러올 수 없습니다" description="팀 정보를 안전하게 불러오지 못했습니다." reference={safeRequestReference(error)} retryHref={`${base}/${encodeURIComponent(teamId)}`} />;
  }
}
