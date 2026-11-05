import { getOrganization } from "@/services/organizations/api.ts";
import { getCurrentWorkspaces } from "@/services/workspaces/api.ts";

import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { WorkspaceSection, WorkspaceTextLink } from "@/app/(workspace)/workspaces/[workspaceId]/_components/workspace-section.tsx";
import { SettingsGroup, SettingsRow, SettingsValue } from "#src/components/ui/settings-group.tsx";

export const metadata: Metadata = { title: "워크스페이스 설정" };

export default async function WorkspaceSettingsPage({ params }: { readonly params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const client = await createServerApiClient();
  const workspaces = (await getCurrentWorkspaces(client)).data.workspaces;
  const workspace = workspaces.find((item) => item.storageScopeId === workspaceId);
  if (workspace === undefined) redirect("/workspaces");
  const organization = workspace.ownerType === "organization"
    ? (await getOrganization(client, workspace.ownerId)).data
    : undefined;
  const base = `/workspaces/${encodeURIComponent(workspaceId)}`;

  return (
    <WorkspaceSection eyebrow={workspace.displayLabel} title="워크스페이스 설정" description="워크스페이스의 소유 범위와 관리 경로를 확인합니다.">
      <SettingsGroup title="기본 정보" description={workspace.ownerType === "user" ? "개인 워크스페이스는 계정과 함께 자동으로 관리됩니다." : "워크스페이스의 표시 정보와 소유 범위입니다."}>
        <SettingsRow title="표시 이름"><SettingsValue>{workspace.displayLabel}</SettingsValue></SettingsRow>
        <SettingsRow title="소유 유형" description="프로젝트와 권한이 귀속되는 범위입니다."><SettingsValue>{workspace.ownerType === "user" ? "개인" : "조직"}</SettingsValue></SettingsRow>
        <SettingsRow title="워크스페이스 ID" description="API 요청에서 사용하는 변경되지 않는 식별자입니다."><SettingsValue>{workspace.storageScopeId}</SettingsValue></SettingsRow>
        <SettingsRow title="상태"><SettingsValue>{organization?.status ?? "사용 가능"}</SettingsValue></SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="접근 관리" description="워크스페이스에 접근하는 멤버와 권한을 관리합니다.">
        <SettingsRow title={workspace.ownerType === "organization" ? "멤버와 초대" : "개인 소유권"} description={workspace.ownerType === "organization" ? "멤버 역할과 대기 중인 초대를 확인합니다." : "개인 워크스페이스는 계정 소유자만 접근할 수 있습니다."}>
          {workspace.ownerType === "organization" ? <WorkspaceTextLink href={`${base}/members`}>멤버 관리 열기</WorkspaceTextLink> : <SettingsValue>계정에서 관리</SettingsValue>}
        </SettingsRow>
      </SettingsGroup>
    </WorkspaceSection>
  );
}
