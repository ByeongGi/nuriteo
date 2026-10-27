import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { AdminAccessRequired } from "#src/app/(admin)/admin/_components/admin-access-required.tsx";
import { AuthenticatedShellLoading } from "#src/app/(authenticated)/authenticated-shell-frame.tsx";
import AdminUpdatesLoading from "#src/app/(admin)/admin/system/updates/loading.tsx";
import ProjectsLoading from "#src/app/(authenticated)/projects/loading.tsx";
import WorkspacesLoading from "#src/app/(authenticated)/workspaces/loading.tsx";
import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { ErrorView } from "#src/app/_components/error-view.tsx";
import { ProductEntryLoading } from "#src/app/_components/product-entry-shell.tsx";
import { ActivationForm } from "#src/app/(public)/activate/activation-form.tsx";
import NotFound from "#src/app/not-found.tsx";

const meta = {
  parameters: {
    layout: "fullscreen",
    nextjs: { appDirectory: true }
  },
  title: "UX Redesign/08 System States"
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const AccountActivation: Story = {
  render: () => <ActivationForm activationToken="storybook-activation-token" />
};

export const InvalidInvitation: Story = {
  render: () => <ActivationForm activationToken={null} />
};

export const EntryLoading: Story = {
  render: () => <ProductEntryLoading label="계정 활성화를 준비하는 중" />
};

export const ApplicationLoading: Story = {
  render: () => <AuthenticatedShellLoading />
};

export const ProjectsLoadingState: Story = {
  render: () => <ProjectsLoading />
};

export const WorkspacesLoadingState: Story = {
  render: () => <WorkspacesLoading />
};

export const AdminUpdateLoadingState: Story = {
  render: () => <AdminUpdatesLoading />
};

export const ServiceUnavailable: Story = {
  render: () => (
    <EntryUnavailable
      description="작업 내용은 변경되지 않았습니다. 연결 상태를 확인한 뒤 다시 시도하세요."
      reference="request-storybook-503"
      retryHref="/workspaces"
      title="워크스페이스를 일시적으로 사용할 수 없습니다"
    />
  )
};

export const UnexpectedError: Story = {
  render: () => <ErrorView onRetry={() => undefined} reference="error-storybook" />
};

export const MissingPage: Story = {
  render: () => <NotFound />
};

export const RestrictedAdministration: Story = {
  render: () => (
    <AdminAccessRequired description="서버 설정을 변경하려면 인스턴스 관리자 권한이 필요합니다." />
  )
};
