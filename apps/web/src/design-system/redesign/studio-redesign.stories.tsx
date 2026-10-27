import type { Project } from "@nuriteo/api-client";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { waitFor } from "storybook/test";

import { ProjectIdeShell } from "#src/projects/project-ide-shell.tsx";
import { ProjectStudioFrame } from "#src/app/(studio)/projects/[projectId]/studio/project-studio-screen.tsx";
import { createStudioRuntimeFeatureLoader } from "#src/design-system/redesign/fixtures/studio-runtime-fixture.ts";

const project: Project = {
  archivedAt: null,
  createdAt: "2026-10-20T01:00:00.000Z",
  id: "0199ee6c-c777-7000-8000-000000000101",
  name: "런타임 편집기",
  ownerId: "user-kim",
  ownerType: "user",
  slug: "runtime-editor",
  state: "active",
  storageScopeId: "user:user-kim",
  templateId: "vite-react",
  updatedAt: "2026-10-22T01:00:00.000Z",
  version: 18
};

const readyRuntime = createStudioRuntimeFeatureLoader({ projectId: project.id });
const largeRuntime = createStudioRuntimeFeatureLoader({ fileCount: 2_500, projectId: project.id });
const conflictRuntime = createStudioRuntimeFeatureLoader({ mode: "conflict", projectId: project.id });
const failureRuntime = createStudioRuntimeFeatureLoader({ mode: "failure", projectId: project.id });

function StudioFixture({
  fixtureProject = project,
  runtimeFeatureLoader = readyRuntime
}: Readonly<{
  fixtureProject?: Project;
  runtimeFeatureLoader?: typeof readyRuntime;
}>) {
  return (
    <ProjectStudioFrame project={fixtureProject} workspaceLabel="김병기의 워크스페이스" workspaceScope="user:user-kim">
      <ProjectIdeShell
        assetRevision={"a".repeat(64)}
        previewConfiguration={{
          code: "PREVIEW_CONFIGURATION_INVALID",
          message: "Storybook에서는 격리 미리보기 연결을 만들지 않습니다.",
          status: "disabled"
        }}
        project={fixtureProject}
        projectEtag={`"project-v${fixtureProject.version}"`}
        resumeProjectContentLoader={async () => ({
          async resumeProjectContent() {
            throw Object.assign(new Error("Storybook project is not saved"), { code: "RESUME_NOT_SAVED" });
          }
        })}
        runtimeFeatureLoader={runtimeFeatureLoader}
        workspaceScope="user:user-kim"
      />
    </ProjectStudioFrame>
  );
}

async function startTemplate({ canvas }: { canvas: { getByRole: (role: string, options: { name: string }) => HTMLElement } }) {
  await waitFor(() => canvas.getByRole("button", { name: "미리보기 실행" }));
}

async function startTemplateWithTerminal(context: Parameters<typeof startTemplate>[0]) {
  await startTemplate(context);
  await waitFor(() => context.canvas.getByRole("button", { name: "터미널" }));
  context.canvas.getByRole("button", { name: "터미널" }).click();
}

async function startTemplateWithSearch(context: Parameters<typeof startTemplate>[0]) {
  await startTemplate(context);
  await waitFor(() => context.canvas.getByRole("button", { name: "프로젝트 파일 검색" }));
  context.canvas.getByRole("button", { name: "프로젝트 파일 검색" }).click();
}

const meta = {
  parameters: {
    layout: "fullscreen",
    nextjs: { appDirectory: true }
  },
  title: "UX Redesign/03 Browser Studio"
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
  play: startTemplate,
  render: () => <StudioFixture />
};

export const TerminalOpen: Story = {
  play: startTemplateWithTerminal,
  render: () => <StudioFixture />
};

export const FileSearch: Story = {
  play: startTemplateWithSearch,
  render: () => <StudioFixture />
};

export const LargeProject: Story = {
  play: startTemplate,
  render: () => <StudioFixture runtimeFeatureLoader={largeRuntime} />
};

export const SaveConflict: Story = {
  play: startTemplate,
  render: () => <StudioFixture runtimeFeatureLoader={conflictRuntime} />
};

export const ReadOnly: Story = {
  render: () => <StudioFixture fixtureProject={{ ...project, archivedAt: "2026-10-22T02:00:00.000Z", state: "archived" }} />
};

export const RuntimeFailure: Story = {
  play: startTemplate,
  render: () => <StudioFixture runtimeFeatureLoader={failureRuntime} />
};
