import type {
  AccessToken,
  MfaStatus,
  NotificationInbox,
  NotificationInboxItem,
  OidcIdentity,
  Workspace
} from "@nuriteo/api-client";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { AccessTokenConsole } from "#src/app/(authenticated)/access-tokens/token-console.tsx";
import { AuthenticatedShellFrame } from "#src/app/(authenticated)/authenticated-shell-frame.tsx";
import { IdentityConnections } from "#src/app/(authenticated)/identities/identity-connections.tsx";
import { NotificationCenter } from "#src/app/(authenticated)/notifications/notification-center.tsx";
import { MfaSecurity as MfaSecurityScreen } from "#src/app/mfa/security.tsx";

const referenceTime = Date.parse("2026-10-22T01:00:00.000Z");
const activeNotifications = createNotificationInbox(100, false);
const archivedNotifications = createNotificationInbox(36, true);
const accessTokens = createAccessTokens(100);
const identities: readonly OidcIdentity[] = [
  { providerDisplayName: "Microsoft Entra ID", providerId: fixtureId(8_101), linkedAt: "2026-09-18T01:00:00.000Z", lastAuthenticatedAt: "2026-10-22T00:52:00.000Z" },
  { providerDisplayName: "Google Workspace", providerId: fixtureId(8_102), linkedAt: "2026-10-02T01:00:00.000Z", lastAuthenticatedAt: "2026-10-14T01:00:00.000Z" },
  { providerDisplayName: "사내 OIDC", providerId: fixtureId(8_103), linkedAt: "2026-10-10T01:00:00.000Z", lastAuthenticatedAt: null }
];
const enrolledMfa: MfaStatus = {
  deadlineAt: null,
  enrolled: true,
  gracePeriodDays: 7,
  localAccount: true,
  notificationState: "none",
  pendingEnrollment: false,
  policyMode: "all_local_users",
  recoveryCodesRemaining: 7,
  required: true,
  restricted: false
};
const accountWorkspaces: readonly Workspace[] = [
  { displayLabel: "김병기의 워크스페이스", ownerId: fixtureId(8_001), ownerType: "user", storageScopeId: fixtureId(8_002) }
];

function AccountShell({ children, pathname }: Readonly<{ children: React.ReactNode; pathname: string }>) {
  return (
    <AuthenticatedShellFrame displayName="김병기" email="byeonggi@nuriteo.dev" isInstanceAdmin pathnameOverride={pathname} themeMode="light" unreadCount={activeNotifications.unreadCount} workspaces={accountWorkspaces}>
      {children}
    </AuthenticatedShellFrame>
  );
}

function NotificationsFixture({ large = false }: Readonly<{ large?: boolean }>) {
  const active = large ? activeNotifications : sliceInbox(activeNotifications, 12, null);
  const archived = large ? archivedNotifications : sliceInbox(archivedNotifications, 4, null);
  return <AccountShell pathname="/notifications"><NotificationCenter initialActive={active} initialArchived={archived} /></AccountShell>;
}

function IdentitiesFixture() {
  return <AccountShell pathname="/account/identities"><IdentityConnections initialIdentities={identities} /></AccountShell>;
}

function TokensFixture({ large = false }: Readonly<{ large?: boolean }>) {
  return <AccountShell pathname="/account/tokens"><AccessTokenConsole initialTokens={large ? accessTokens : accessTokens.slice(0, 8)} referenceTime={referenceTime} target={{ kind: "personal" }} /></AccountShell>;
}

function createNotificationInbox(count: number, archived: boolean): NotificationInbox {
  const items = Array.from({ length: count }, (_, index) => createNotification(index, archived));
  return {
    items,
    nextCursor: count >= 100 ? "next-notification-page" : null,
    unreadCount: archived ? 0 : items.filter((item) => item.status === "unread").length
  };
}

function createNotification(index: number, archived: boolean): NotificationInboxItem {
  const classifications = ["critical_security", "account_access", "collaboration", "operations"] as const;
  const titles = ["새 로그인 수단이 연결되었습니다.", "프로젝트 초대를 받았습니다.", "미리보기 배포가 완료되었습니다.", "복구 코드가 다시 생성되었습니다."] as const;
  return {
    actionState: index % 9 === 0 ? "pending" : "none",
    classification: classifications[index % classifications.length]!,
    eventCode: `account.event.${index + 1}`,
    id: fixtureId(9_000 + index + (archived ? 500 : 0)),
    occurredAt: new Date(referenceTime - index * 600_000).toISOString(),
    occurrenceCount: index % 7 === 0 ? 3 : 1,
    status: archived ? "archived" : index % 3 === 0 ? "unread" : "read",
    summary: `누리터 계정과 프로젝트 활동 ${index + 1}에 대한 상세 알림입니다. 필요한 경우 상태를 확인하세요.`,
    title: titles[index % titles.length]!,
    version: 1 + (index % 4)
  };
}

function createAccessTokens(count: number): readonly AccessToken[] {
  const scopes = ["project:read", "project:write", "project:publish", "git:read", "git:write"] as const;
  return Array.from({ length: count }, (_, index) => {
    const status = index % 11 === 0 ? "revoked" : index % 13 === 0 ? "expired" : "active";
    return {
      createdAt: new Date(referenceTime - (index + 20) * 86_400_000).toISOString(),
      expiresAt: new Date(referenceTime + (index + 5) * 86_400_000).toISOString(),
      id: fixtureId(10_000 + index),
      kind: "personal",
      lastApiCategory: index % 4 === 0 ? "projects" : null,
      lastUsedAt: index % 5 === 0 ? null : new Date(referenceTime - index * 3_600_000).toISOString(),
      name: index === 0 ? "preview-deploy" : `automation-token-${String(index + 1).padStart(3, "0")}`,
      prefix: `nrt_${String(index + 1).padStart(6, "0")}`,
      projectId: null,
      recentSourceIps: index % 5 === 0 ? [] : ["203.0.113.10"],
      revokedAt: status === "revoked" ? "2026-10-20T01:00:00.000Z" : null,
      scopes: [scopes[index % scopes.length]!, scopes[(index + 1) % scopes.length]!],
      status
    };
  });
}

function sliceInbox(inbox: NotificationInbox, count: number, nextCursor: string | null): NotificationInbox {
  return { ...inbox, items: inbox.items.slice(0, count), nextCursor };
}

function fixtureId(value: number): string {
  return `0199ee6c-c777-7000-8000-${String(value).padStart(12, "0")}`;
}

const meta = {
  parameters: {
    layout: "fullscreen",
    nextjs: { appDirectory: true }
  },
  title: "UX Redesign/05 Account & Security"
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Notifications: Story = { render: () => <NotificationsFixture /> };
export const LargeNotificationInbox: Story = { render: () => <NotificationsFixture large /> };
export const ConnectedIdentities: Story = { render: () => <IdentitiesFixture /> };
export const AccessTokens: Story = { render: () => <TokensFixture /> };
export const LargeTokenDirectory: Story = { render: () => <TokensFixture large /> };
export const MfaSecurity: Story = { render: () => <MfaSecurityScreen displayName="김병기" status={enrolledMfa} /> };
export const RestrictedMfa: Story = { render: () => <MfaSecurityScreen displayName="김병기" status={{ ...enrolledMfa, deadlineAt: "2026-10-21T01:00:00.000Z", enrolled: false, notificationState: "overdue", recoveryCodesRemaining: 0, restricted: true }} /> };
