import { getCurrentWorkspaces, getOrganization } from "@nuriteo/api-client";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { WorkspaceFacts, WorkspacePanel, WorkspaceSection, WorkspaceTextLink } from "#src/app/(authenticated)/workspaces/[workspaceId]/workspace-section.tsx";

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
      <WorkspacePanel title="기본 정보" description={workspace.ownerType === "user" ? "개인 워크스페이스는 계정과 함께 자동으로 관리됩니다." : "조직 정보 변경은 멤버 관리 화면에서 권한에 따라 제공됩니다."}>
        <WorkspaceFacts items={[
          { label: "표시 이름", value: workspace.displayLabel },
          { label: "유형", value: workspace.ownerType === "user" ? "개인" : "조직" },
          { label: "워크스페이스 ID", value: workspace.storageScopeId },
          { label: "상태", value: organization?.status ?? "사용 가능" }
        ]} />
        {workspace.ownerType === "organization" ? <WorkspaceTextLink href={`${base}/members`}>조직 멤버와 초대 관리</WorkspaceTextLink> : <p className="m-0 text-sm text-muted-foreground">개인 워크스페이스 이름은 계정 표시 정보에서 파생되며 별도의 변경 API를 제공하지 않습니다.</p>}
      </WorkspacePanel>
    </WorkspaceSection>
  );
}
