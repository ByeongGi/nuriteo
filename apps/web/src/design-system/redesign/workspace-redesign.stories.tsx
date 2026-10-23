import type { Project, Workspace } from "@nuriteo/api-client";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { ReactNode } from "react";

import { AuthenticatedShellFrame } from "#src/app/(authenticated)/authenticated-shell-frame.tsx";
import { WorkspaceShellFrame } from "#src/app/(workspace)/workspace-shell-frame.tsx";
import { ProjectDashboard } from "#src/app/(authenticated)/projects/project-dashboard.tsx";
import {
  EmptyWorkspaceScreen as EmptyWorkspaceContent,
  WorkspaceScreen
} from "#src/app/(authenticated)/workspaces/workspace-catalog.tsx";

const workspaceRows: readonly Workspace[] = [
  { displayLabel: "김병기의 워크스페이스", ownerId: "user-kim", ownerType: "user", storageScopeId: "user:user-kim" },
  { displayLabel: "누리터 팀", ownerId: "organization-nuriteo", ownerType: "organization", storageScopeId: "organization:organization-nuriteo" },
  { displayLabel: "플랫폼 랩", ownerId: "organization-platform", ownerType: "organization", storageScopeId: "organization:organization-platform" }
];

const projectRows = createProjectFixtures(4);
const selectedProject = projectRows[0]!;

function WorkspaceProjectShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <WorkspaceShellFrame displayName="김병기" email="byeonggi@example.com" themeMode="light" unreadCount={3} workspace={workspaceRows[0]!}>
      {children}
    </WorkspaceShellFrame>
  );
}

function WorkspaceOverviewScreen() {
  return (
    <AuthenticatedShellFrame displayName="김병기" email="byeonggi@example.com" isInstanceAdmin pathnameOverride="/workspaces" themeMode="light" unreadCount={3} workspaces={workspaceRows}>
      <WorkspaceScreen workspaces={workspaceRows} />
    </AuthenticatedShellFrame>
  );
}

function EmptyWorkspaceScreen() {
  return (
    <AuthenticatedShellFrame displayName="김병기" email="byeonggi@example.com" isInstanceAdmin pathnameOverride="/workspaces" themeMode="light" unreadCount={0} workspaces={workspaceRows}>
      <EmptyWorkspaceContent />
    </AuthenticatedShellFrame>
  );
}

function WorkspaceHomeScreen() {
  return (
    <WorkspaceProjectShell>
      <ProjectDashboard initialCollection={{ items: projectRows, nextCursor: null }} selectedScope="user:user-kim" selectedState="active" workspaces={workspaceRows} />
    </WorkspaceProjectShell>
  );
}

function ProjectCatalogScreen() {
  return (
    <WorkspaceProjectShell>
      <ProjectDashboard initialCollection={{ items: projectRows, nextCursor: null }} selectedScope="user:user-kim" selectedState="active" workspaces={workspaceRows} />
    </WorkspaceProjectShell>
  );
}

function LargeProjectCatalogScreen() {
  const projects = createProjectFixtures(100);
  return (
    <WorkspaceProjectShell>
      <ProjectDashboard initialCollection={{ items: projects, nextCursor: "next-page-fixture" }} selectedScope="user:user-kim" selectedState="active" workspaces={workspaceRows} />
    </WorkspaceProjectShell>
  );
}

function NewProjectScreen() {
  return (
    <WorkspaceProjectShell>
      <ProjectDashboard selectedScope="user:user-kim" selectedState="active" view="create" workspaces={workspaceRows} />
    </WorkspaceProjectShell>
  );
}

function ProjectDetailScreen() {
  return (
    <WorkspaceProjectShell>
      <ProjectDashboard
        initialCollection={{ items: projectRows, nextCursor: null }}
        initialGitState={{ connections: [], providers: [] }}
        initialProject={selectedProject}
        initialProjectEtag={`"project-v${selectedProject.version}"`}
        selectedScope="user:user-kim"
        selectedState="active"
        workspaces={workspaceRows}
      />
    </WorkspaceProjectShell>
  );
}

function createProjectFixtures(count: number): readonly Project[] {
  const names = ["런타임 편집기", "미리보기 서비스", "디자인 시스템", "온보딩 포털"] as const;
  return Array.from({ length: count }, (_, index) => {
    const suffix = String(index + 1).padStart(12, "0");
    const name = count <= names.length ? names[index] ?? `프로젝트 ${index + 1}` : `브라우저 프로젝트 ${index + 1}`;
    return {
      archivedAt: null,
      createdAt: "2026-10-20T01:00:00.000Z",
      id: `0199ee6c-c777-7000-8000-${suffix}`,
      name,
      ownerId: "user-kim",
      ownerType: "user",
      slug: `browser-project-${index + 1}`,
      state: "active",
      storageScopeId: "user:user-kim",
      updatedAt: "2026-10-22T01:00:00.000Z",
      version: 18 - (index % 8)
    } satisfies Project;
  });
}

const meta = {
  parameters: {
    layout: "fullscreen",
    nextjs: { appDirectory: true }
  },
  title: "UX Redesign/02 Workspaces & Projects"
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const WorkspaceOverview: Story = { render: () => <WorkspaceOverviewScreen /> };
export const WorkspaceHomePage: Story = { render: () => <WorkspaceHomeScreen /> };
export const EmptyWorkspace: Story = { render: () => <EmptyWorkspaceScreen /> };
export const ProjectCatalog: Story = { render: () => <ProjectCatalogScreen /> };
export const NewProject: Story = { render: () => <NewProjectScreen /> };
export const LargeProjectCatalog: Story = { render: () => <LargeProjectCatalogScreen /> };
export const ProjectDetail: Story = { render: () => <ProjectDetailScreen /> };
