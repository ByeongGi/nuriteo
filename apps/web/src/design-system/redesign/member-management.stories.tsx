import type { OrganizationMember, Workspace } from "@nuriteo/api-client";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { MemberDirectory } from "#src/app/(workspace)/workspaces/[workspaceId]/members/member-directory.tsx";
import { WorkspaceShellFrame } from "#src/app/(workspace)/workspace-shell-frame.tsx";

const workspaceId = "0199ee6c-c777-7000-8000-000000008001";
const currentUserId = "0199ee6c-c777-7000-8000-000000008101";
const workspace: Workspace = { displayLabel: "누리터 팀", ownerId: "0199ee6c-c777-7000-8000-000000008201", ownerType: "organization", storageScopeId: workspaceId };
const members: readonly OrganizationMember[] = [
  { displayName: "김병기", role: "owner", userId: currentUserId },
  { displayName: "이나라", role: "owner", userId: "0199ee6c-c777-7000-8000-000000008102" },
  { displayName: "박해솔", role: "member", userId: "0199ee6c-c777-7000-8000-000000008103" },
  { displayName: "최다은", role: "member", userId: "0199ee6c-c777-7000-8000-000000008104" },
  { displayName: "정유진", role: "member", userId: "0199ee6c-c777-7000-8000-000000008105" }
];

function DirectoryStory() {
  return <WorkspaceShellFrame displayName="김병기" email="byeonggi@nuriteo.dev" themeMode="light" workspace={workspace}><MemberDirectory canManage currentUserId={currentUserId} members={members} organizationName={workspace.displayLabel} workspaceId={workspaceId} /></WorkspaceShellFrame>;
}

const meta = { parameters: { layout: "fullscreen", nextjs: { appDirectory: true } }, title: "UX Redesign/04 Workspace Members" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Directory: Story = { render: () => <DirectoryStory /> };
