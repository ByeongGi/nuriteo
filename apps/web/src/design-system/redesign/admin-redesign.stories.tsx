import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { ReactNode } from "react";

import { AdminShellFrame } from "#src/app/(admin)/admin/admin-shell-frame.tsx";
import { BackupConsole } from "#src/app/(admin)/admin/backups/backup-console.tsx";
import { GitProviderConsole } from "#src/app/(admin)/admin/git-providers/provider-console.tsx";
import { ActivationInvitations } from "#src/app/(admin)/admin/invitations/activation-invitations.tsx";
import { MaintenanceConsole } from "#src/app/(admin)/admin/maintenance/maintenance-console.tsx";
import { MfaPolicyEditor } from "#src/app/(admin)/admin/mfa/policy-editor.tsx";
import { EmailDeliveryConsole } from "#src/app/(admin)/admin/notifications/email-delivery-console.tsx";
import { OidcProviderConsole } from "#src/app/(admin)/admin/oidc/provider-console.tsx";
import { OperationsDashboard } from "#src/app/(admin)/admin/operations/operations-dashboard.tsx";
import { RegistryConsole } from "#src/app/(admin)/admin/registries/registry-console.tsx";
import { SmtpTrustScreen } from "#src/app/(admin)/admin/smtp-trust/smtp-trust-screen.tsx";
import { AdminSettings } from "#src/app/(admin)/admin/settings/admin-settings.tsx";
import { UpdateReadinessConsole } from "#src/app/(admin)/admin/updates/update-readiness-console.tsx";
import AdminHomePage from "#src/app/(admin)/admin/page.tsx";
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

export const AdminHome: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin">
      <AdminHomePage />
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

export const InstanceSettings: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/settings">
      <AdminSettings cleanup={adminCleanup} settings={adminSettings} status={adminStatus} />
    </AdminStoryFrame>
  )
};

export const Maintenance: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/maintenance">
      <MaintenanceConsole initial={adminMaintenance} />
    </AdminStoryFrame>
  )
};

export const Backups: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/backups">
      <BackupConsole initial={adminBackup} />
    </AdminStoryFrame>
  )
};

export const Updates: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/updates">
      <UpdateReadinessConsole history={adminUpdateHistory} readiness={adminUpdateReadiness} />
    </AdminStoryFrame>
  )
};

export const ActivationAccounts: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/invitations">
      <ActivationInvitations invitations={activationInvitations} />
    </AdminStoryFrame>
  )
};

export const MfaPolicy: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/mfa">
      <MfaPolicyEditor initial={adminMfaPolicy} />
    </AdminStoryFrame>
  )
};

export const AuthenticationProviders: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/oidc">
      <OidcProviderConsole initialProviders={oidcProviders} />
    </AdminStoryFrame>
  )
};

export const PackageRegistries: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/registries">
      <RegistryConsole initialConfiguration={registryConfiguration} />
    </AdminStoryFrame>
  )
};

export const GitProviders: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/git-providers">
      <GitProviderConsole initialProviders={gitProviders} />
    </AdminStoryFrame>
  )
};

export const EmailDelivery: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/notifications">
      <EmailDeliveryConsole initial={emailDeliveries} />
    </AdminStoryFrame>
  )
};

export const SmtpCertificates: Story = {
  render: () => (
    <AdminStoryFrame pathname="/admin/smtp-trust">
      <SmtpTrustScreen initialCollection={smtpCaCollection} />
    </AdminStoryFrame>
  )
};
