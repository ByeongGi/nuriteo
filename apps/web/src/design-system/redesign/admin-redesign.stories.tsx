import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { AdminShellFrame } from "#src/app/(admin)/admin/admin-shell-frame.tsx";
import { BackupConsole } from "#src/app/(admin)/admin/backups/backup-console.tsx";
import { GitProviderConsole } from "#src/app/(admin)/admin/git-providers/provider-console.tsx";
import { ActivationInvitations, NewActivationInvitation } from "#src/app/(admin)/admin/invitations/activation-invitations.tsx";
import { MaintenanceConsole } from "#src/app/(admin)/admin/maintenance/maintenance-console.tsx";
import { MfaPolicyEditor } from "#src/app/(admin)/admin/mfa/policy-editor.tsx";
import { EmailDeliveryConsole } from "#src/app/(admin)/admin/notifications/email-delivery-console.tsx";
import { OidcProviderConsole } from "#src/app/(admin)/admin/oidc/provider-console.tsx";
import { OperationsDashboard } from "#src/app/(admin)/admin/operations/operations-dashboard.tsx";
import { StorageCleanupPreview } from "#src/app/(admin)/admin/operations/storage-cleanup/cleanup-preview.tsx";
import { RegistryConsole } from "#src/app/(admin)/admin/registries/registry-console.tsx";
import { SmtpTrustScreen } from "#src/app/(admin)/admin/smtp-trust/smtp-trust-screen.tsx";
import { AdminSettings } from "#src/app/(admin)/admin/settings/admin-settings.tsx";
import { AuditLogTable } from "#src/app/(admin)/admin/system/audit-log/audit-log-table.tsx";
import { UpdateApprovalHistory, UpdateReadinessConsole } from "#src/app/(admin)/admin/updates/update-readiness-console.tsx";
import {
  adminBackup,
  adminCleanup,
  adminMaintenance,
  adminOperations,
  adminSettings,
  adminStatus,
  adminUpdateHistory,
  adminUpdateReadiness,
  activationInvitations,
  adminMfaPolicy,
  emailDeliveries,
  gitProviders,
  oidcProviders,
  registryConfiguration,
  smtpCaCollection
} from "#src/design-system/redesign/fixtures/admin-fixtures.ts";

const auditQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function AdminStoryFrame({
  children,
  pathname
}: Readonly<{ children: ReactNode; pathname: string }>) {
  return (
    <AdminShellFrame
      displayName="김병기"
      email="byeonggi@nuriteo.dev"
      pathnameOverride={pathname}
      themeMode="light"
    >
      {children}
    </AdminShellFrame>
  );
}

const meta = {
  parameters: {
    layout: "fullscreen",
    nextjs: { appDirectory: true }
  },
  title: "UX Redesign/06 Administration"
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const AdminLanding: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/operations">
      <OperationsDashboard operations={adminOperations} />
    </AdminStoryFrame>
  )
};

export const Operations: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/operations">
      <OperationsDashboard operations={adminOperations} />
    </AdminStoryFrame>
  )
};

export const StorageCleanup: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/operations/storage-cleanup">
      <StorageCleanupPreview initial={adminCleanup} />
    </AdminStoryFrame>
  )
};

export const InstanceSettings: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/system/settings">
      <AdminSettings settings={adminSettings} status={adminStatus} />
    </AdminStoryFrame>
  )
};

export const AuditLog: Story = {
  render: () => (
    <QueryClientProvider client={auditQueryClient}><AdminStoryFrame pathname="/admin/system/audit-log">
      <AuditLogTable initialPage={{
        items: Array.from({ length: 25 }, (_, index) => ({
          actionCode: index % 3 === 0 ? "auth.login_succeeded" : index % 3 === 1 ? "project.created" : "organization.created",
          actorDisplayName: index % 5 === 0 ? null : `관리자 ${index + 1}`,
          actorId: `0199ee6c-c777-7000-8000-${String(index + 1).padStart(12, "0")}`,
          id: `0199ee6c-c777-7000-9000-${String(index + 1).padStart(12, "0")}`,
          occurredAt: new Date(Date.UTC(2026, 9, 24, 3, 30 - index)).toISOString(),
          result: index % 7 === 0 ? "failed" : "succeeded",
          targetId: `resource-${String(index + 1).padStart(3, "0")}`,
          targetType: index % 2 === 0 ? "project" : "organization"
        })),
        nextCursor: "next-audit-page"
      }} />
    </AdminStoryFrame></QueryClientProvider>
  )
};

export const Maintenance: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/operations/maintenance">
      <MaintenanceConsole initial={adminMaintenance} />
    </AdminStoryFrame>
  )
};

export const Backups: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/operations/backups">
      <BackupConsole initial={adminBackup} />
    </AdminStoryFrame>
  )
};

export const BackupPolicy: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/operations/backups/policy">
      <BackupConsole initial={adminBackup} view="policy" />
    </AdminStoryFrame>
  )
};

export const BackupActions: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/operations/backups/actions">
      <BackupConsole initial={adminBackup} view="actions" />
    </AdminStoryFrame>
  )
};

export const Updates: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/system/updates">
      <UpdateReadinessConsole readiness={adminUpdateReadiness} />
    </AdminStoryFrame>
  )
};

export const ActivationAccounts: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/access/invitations">
      <ActivationInvitations initial={{ items: activationInvitations, nextCursor: null }} />
    </AdminStoryFrame>
  )
};

export const NewActivationAccount: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/access/invitations/new">
      <NewActivationInvitation />
    </AdminStoryFrame>
  )
};

export const UpdateHistory: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/system/updates/history">
      <UpdateApprovalHistory history={adminUpdateHistory} />
    </AdminStoryFrame>
  )
};

export const MfaPolicy: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/authentication/mfa">
      <MfaPolicyEditor initial={adminMfaPolicy} />
    </AdminStoryFrame>
  )
};

export const AuthenticationProviders: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/authentication/oidc">
      <OidcProviderConsole initialProviders={oidcProviders} />
    </AdminStoryFrame>
  )
};

export const AuthenticationProviderDetail: Story = {
  render: () => (
    <AdminStoryFrame pathname={`/admin/authentication/oidc/${oidcProviders[0]?.id ?? "provider"}`}>
      <OidcProviderConsole detailMode initialProviders={oidcProviders.slice(0, 1)} />
    </AdminStoryFrame>
  )
};

export const NewAuthenticationProvider: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/authentication/oidc/new">
      <OidcProviderConsole createMode initialProviders={[]} />
    </AdminStoryFrame>
  )
};

export const PackageRegistries: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/integrations/registries">
      <RegistryConsole initialConfiguration={registryConfiguration} />
    </AdminStoryFrame>
  )
};

export const PackageRegistryDetail: Story = {
  render: () => (
    <AdminStoryFrame pathname={`/admin/integrations/registries/${registryConfiguration.items[0]?.id ?? "registry"}`}>
      <RegistryConsole
        detailMode
        initialConfiguration={{
          items: registryConfiguration.items.slice(0, 1),
          scopes: registryConfiguration.scopes.filter((scope) => scope.connectionId === registryConfiguration.items[0]?.id)
        }}
      />
    </AdminStoryFrame>
  )
};

export const NewPackageRegistry: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/integrations/registries/new">
      <RegistryConsole createMode initialConfiguration={{ items: [], scopes: [] }} />
    </AdminStoryFrame>
  )
};

export const GitProviders: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/integrations/git">
      <GitProviderConsole initialProviders={gitProviders} />
    </AdminStoryFrame>
  )
};

export const GitProviderDetail: Story = {
  render: () => (
    <AdminStoryFrame pathname={`/admin/integrations/git/${gitProviders[0]?.id ?? "provider"}`}>
      <GitProviderConsole detailMode initialProviders={gitProviders.slice(0, 1)} />
    </AdminStoryFrame>
  )
};

export const NewGitProvider: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/integrations/git/new">
      <GitProviderConsole createMode initialProviders={[]} />
    </AdminStoryFrame>
  )
};

export const EmailDelivery: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/operations/email-deliveries">
      <EmailDeliveryConsole initial={emailDeliveries} />
    </AdminStoryFrame>
  )
};

export const SmtpCertificates: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/integrations/smtp/trust">
      <SmtpTrustScreen initialCollection={smtpCaCollection} />
    </AdminStoryFrame>
  )
};
