import type { PublicPublishedExample, Workspace } from "@nuriteo/api-client";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { PublicExampleDetail } from "#src/app/examples/_components/public-example-detail.tsx";
import { PublicExamplesScreen } from "#src/app/examples/_components/public-examples-screen.tsx";
import { ReadOnlyExampleShell } from "#src/app/examples/_components/read-only-example-shell.tsx";

const publicId = "ExESEhISEhISEhISEhISEhISEhISEhISEhISEhISEgA";

const featuredExample: PublicPublishedExample = {
  name: "서비스 운영 대시보드",
  publicId,
  publishedAt: "2026-10-20T05:32:00.000Z",
  versionNumber: 12,
  visibility: "public"
};

const featuredExamples: readonly PublicPublishedExample[] = [
  featuredExample,
  {
    name: "팀 노트 API",
    publicId: "TmESEhISEhISEhISEhISEhISEhISEhISEhISEhISEgA",
    publishedAt: "2026-10-18T10:12:00.000Z",
    versionNumber: 8,
    visibility: "public"
  },
  {
    name: "반응형 제품 소개 페이지",
    publicId: "LnESEhISEhISEhISEhISEhISEhISEhISEhISEhISEgA",
    publishedAt: "2026-10-16T03:45:00.000Z",
    versionNumber: 5,
    visibility: "unlisted"
  }
];

const largeExamples: readonly PublicPublishedExample[] = Array.from({ length: 100 }, (_, index) => ({
  name: `${["운영 대시보드", "업무 자동화", "문서 협업", "고객 지원", "데이터 탐색"][index % 5]} ${index + 1}`,
  publicId: `story-public-example-${String(index + 1).padStart(3, "0")}`,
  publishedAt: new Date(Date.UTC(2026, 9, 22 - (index % 20), 1 + (index % 12))).toISOString(),
  versionNumber: 1 + (index % 24),
  visibility: index % 4 === 0 ? "unlisted" : "public"
}));

const workspaces: readonly Workspace[] = [
  {
    displayLabel: "김병기의 워크스페이스",
    ownerId: "0199ee6c-c777-7000-8000-000000007001",
    ownerType: "user",
    storageScopeId: "0199ee6c-c777-7000-8000-000000007101"
  },
  {
    displayLabel: "누리터 제품 팀",
    ownerId: "0199ee6c-c777-7000-8000-000000007002",
    ownerType: "organization",
    storageScopeId: "0199ee6c-c777-7000-8000-000000007102"
  }
];

const disabledPreview = {
  code: "PREVIEW_CONFIGURATION_INVALID",
  message: "Storybook에서는 격리 미리보기 연결을 만들지 않습니다.",
  status: "disabled"
} as const;

const meta = {
  parameters: {
    layout: "fullscreen",
    nextjs: { appDirectory: true }
  },
  title: "UX Redesign/07 Public Examples"
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {
  render: () => <PublicExamplesScreen examples={featuredExamples} />
};

export const LargeGallery: Story = {
  render: () => <PublicExamplesScreen examples={largeExamples} />
};

export const EmptyGallery: Story = {
  render: () => <PublicExamplesScreen examples={[]} />
};

export const Detail: Story = {
  render: () => <PublicExampleDetail example={featuredExample} />
};

export const FixedVersion: Story = {
  render: () => (
    <ReadOnlyExampleShell
      example={featuredExample}
      initialForkWorkspaces={workspaces}
      previewConfiguration={disabledPreview}
    />
  )
};
