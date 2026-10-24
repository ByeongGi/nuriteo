import type { Team, Workspace } from "@nuriteo/api-client";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { TeamDirectory } from "#src/app/(workspace)/workspaces/[workspaceId]/teams/team-directory.tsx";
import { WorkspaceShellFrame } from "#src/app/(workspace)/workspace-shell-frame.tsx";

const workspaceId = "0199ee6c-c777-7000-8000-000000009001";
const workspace: Workspace = { displayLabel: "누리터 팀", ownerId: "0199ee6c-c777-7000-8000-000000009101", ownerType: "organization", storageScopeId: workspaceId };
const teams: readonly Team[] = [
  { createdAt: "2026-09-01T01:00:00.000Z", displayName: "플랫폼", id: "0199ee6c-c777-7000-8000-000000009201", organizationId: workspace.ownerId, slug: "platform", updatedAt: "2026-10-22T01:00:00.000Z", version: 7 },
  { createdAt: "2026-09-02T01:00:00.000Z", displayName: "제품 디자인", id: "0199ee6c-c777-7000-8000-000000009202", organizationId: workspace.ownerId, slug: "product-design", updatedAt: "2026-10-22T01:00:00.000Z", version: 4 },
  { createdAt: "2026-09-03T01:00:00.000Z", displayName: "서비스 운영", id: "0199ee6c-c777-7000-8000-000000009203", organizationId: workspace.ownerId, slug: "service-ops", updatedAt: "2026-10-22T01:00:00.000Z", version: 3 },
  { createdAt: "2026-09-04T01:00:00.000Z", displayName: "성장", id: "0199ee6c-c777-7000-8000-000000009204", organizationId: workspace.ownerId, slug: "growth", updatedAt: "2026-10-22T01:00:00.000Z", version: 2 }
];

function DirectoryStory() {
  return <WorkspaceShellFrame displayName="김병기" email="byeonggi@nuriteo.dev" themeMode="light" workspace={workspace}><TeamDirectory canCreateTeam organizationName={workspace.displayLabel} teams={teams} workspaceId={workspaceId} /></WorkspaceShellFrame>;
}

const meta = { parameters: { layout: "fullscreen", nextjs: { appDirectory: true } }, title: "UX Redesign/04 Workspace Teams" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Directory: Story = { render: () => <DirectoryStory /> };
