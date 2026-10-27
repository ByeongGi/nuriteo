import type {
  ActivationInvitation,
  AdminBackupConsole,
  AdminOperations,
  AdminPolicyCleanupPreview,
  AdminSettingCollection,
  AdminStatus,
  EmailDeliveryCollection,
  GitProviderAdmin,
  IntegrationCaCollection,
  MfaPolicy,
  OidcProvider,
  RegistryConfiguration
} from "@nuriteo/api-client";

import type { AdminMaintenanceStatus } from "#src/app/(admin)/admin/operations/maintenance/maintenance-model.ts";
import type {
  AdminUpdateHistory,
  AdminUpdateReadiness
} from "#src/app/(admin)/admin/system/updates/update-model.ts";

export const adminOperations: AdminOperations = {
  cleanup: {
    failedCount: 0,
    oldestEligibleAgeSeconds: 1_080,
    queueDepth: 4,
    retryCount: 1,
    runningCount: 2,
    state: "nominal"
  },
  dependencies: { category: null, state: "nominal" },
  generatedAt: "2026-10-22T01:32:00.000Z",
  overallState: "nominal",
  supportBundle: {
    excludes: ["프로젝트 파일", "자격 증명", "요청 본문", "데이터베이스 행"],
    format: "nuriteo-support-bundle-v1+json",
    includes: ["릴리스와 스키마 버전", "서비스 준비 상태", "정리 대기열 집계", "익명화된 사용량"],
    maximumBytes: 65_536
  },
  usage: {
    activeOrganizations: 8,
    activeProjects: 142,
    activeUsers: 56,
    reservedBytes: "98784247808",
    state: "nominal",
    trackedPhysicalBytes: "73014444032",
    verifiedBundles: 387
  }
};

export const adminMaintenance: AdminMaintenanceStatus = {
  activeWrites: 4,
  phase: "active",
  writeAdmissionOpen: true
};

export const adminBackup: AdminBackupConsole = {
  alerts: [],
  operations: [
    {
      backupId: fixtureId(6_101),
      completedAt: "2026-10-22T00:14:00.000Z",
      failureCode: null,
      id: fixtureId(6_201),
      kind: "create",
      requestedAt: "2026-10-22T00:06:00.000Z",
      source: "schedule",
      startedAt: "2026-10-22T00:06:30.000Z",
      state: "succeeded"
    },
    {
      backupId: fixtureId(6_102),
      completedAt: "2026-10-21T02:12:00.000Z",
      failureCode: null,
      id: fixtureId(6_202),
      kind: "verify",
      requestedAt: "2026-10-21T02:04:00.000Z",
      source: "manual",
      startedAt: "2026-10-21T02:04:20.000Z",
      state: "succeeded"
    }
  ],
  policy: {
    criticalAfterFailures: 3,
    dailyRetention: 14,
    drillFrequency: "monthly",
    drillTime: "04:00",
    drillTimezone: "Asia/Seoul",
    enabled: true,
    failedRetentionDays: 7,
    intervalHours: 24,
    monthlyRetention: 12,
    multipartCleanupHours: 24,
    scheduleTime: "03:00",
    scheduleTimezone: "Asia/Seoul",
    version: 7,
    warningAfterHours: 26,
    weeklyRetention: 8
  },
  pruneCandidates: 3,
  restorePoints: [
    {
      completedAt: "2026-10-22T00:14:00.000Z",
      id: fixtureId(6_101),
      objectCount: 4_218,
      payloadBytes: "13314398618",
      releaseVersion: "0.2.0",
      retainedAs: ["daily", "weekly"],
      schemaVersion: 47
    },
    {
      completedAt: "2026-10-21T00:13:00.000Z",
      id: fixtureId(6_102),
      objectCount: 4_102,
      payloadBytes: "13108334592",
      releaseVersion: "0.2.0",
      retainedAs: ["daily"],
      schemaVersion: 47
    }
  ]
};

export const adminCleanup: AdminPolicyCleanupPreview = {
  batchLimit: 100,
  dryRun: true,
  eligibleCandidates: 18,
  expectedReclaimBytes: "2684354560",
  gcEnabled: true,
  gracePeriodSeconds: 604_800
};

export const adminStatus: AdminStatus = {
  releaseVersion: "0.2.0",
  restartRequired: false,
  schemaVersion: 47,
  settingCount: 9,
  settingRegistryVersion: 4
};

export const adminSettings: AdminSettingCollection = {
  items: [
    numberSetting("security.reauthentication_window_minutes", 30, 5, 240, "security"),
    numberSetting("audit.retention_days", 365, 30, 2_555, "audit"),
    numberSetting("notifications.general_retention_days", 90, 7, 365, "notification"),
    numberSetting("notifications.security_retention_days", 365, 90, 2_555, "notification"),
    numberSetting("tokens.default_expiry_days", 30, 1, 365, "token"),
    numberSetting("tokens.maximum_expiry_days", 90, 1, 730, "token"),
    {
      applyMode: "live",
      constraint: { kind: "boolean" },
      defaultValue: true,
      key: "object_storage.gc_enabled",
      policyCategory: "object_storage",
      value: true,
      version: 2
    },
    {
      applyMode: "new_runtime",
      constraint: { allowed: ["isolated", "restricted"], kind: "enumeration" },
      defaultValue: "isolated",
      key: "runtime.network.default",
      policyCategory: "runtime",
      value: "isolated",
      version: 4
    },
    {
      applyMode: "live",
      constraint: { allowed: ["optional", "all_local_users"], kind: "enumeration" },
      defaultValue: "optional",
      key: "security.mfa_enforcement",
      policyCategory: "security",
      value: "all_local_users",
      version: 9
    }
  ],
  registryVersion: 4
};

export const adminUpdateReadiness: AdminUpdateReadiness = {
  approvalAllowed: true,
  blockers: [],
  compatibility: {
    configurationRegistryVersion: 4,
    failurePolicy: "변경 전 중지",
    imagePolicy: "다이제스트 고정 전체 세트",
    objectPolicy: "현재 위치에서 읽기 · 재작성 금지",
    releaseLineage: "nuriteo-self-hosted-v1",
    schemaPolicy: "정방향 정확 접두사",
    sourceMigration: 46
  },
  currentRelease: "0.1.0",
  generatedAt: "2026-10-22T01:32:00.000Z",
  preflight: {
    blockerCode: null,
    currentMigration: 46,
    schemaState: "업데이트 필요",
    state: "passed",
    targetMigration: 47
  },
  state: "ready",
  targetRelease: "0.2.0"
};

export const adminUpdateHistory: AdminUpdateHistory = {
  items: [
    { action: "approved", id: fixtureId(6_301), occurredAt: "2026-09-28T02:14:00.000Z", result: "recorded", targetRelease: "0.1.0" },
    { action: "approved", id: fixtureId(6_302), occurredAt: "2026-08-17T01:05:00.000Z", result: "recorded", targetRelease: "0.0.9" }
  ],
  nextCursor: null
};

export const activationInvitations: readonly ActivationInvitation[] = [
  invitation(6_401, "admin2@nuriteo.dev", "pending", "2026-10-29T01:00:00.000Z"),
  invitation(6_402, "developer@nuriteo.dev", "accepted", "2026-10-27T01:00:00.000Z"),
  invitation(6_403, "expired-user@nuriteo.dev", "expired", "2026-10-12T01:00:00.000Z"),
  invitation(6_404, "revoked-user@nuriteo.dev", "revoked", "2026-10-18T01:00:00.000Z")
];

export const adminMfaPolicy: MfaPolicy = {
  affectedUsers: 48,
  enrolledLocalAdministrators: 3,
  gracePeriodDays: 7,
  immediatelyRestrictedUsers: 0,
  mode: "all_local_users",
  version: 9
};

export const oidcProviders: readonly OidcProvider[] = [
  {
    clientId: "nuriteo-production",
    configVersion: 5,
    createdAt: "2026-08-20T01:00:00.000Z",
    displayName: "Microsoft Entra ID",
    id: fixtureId(6_501),
    issuer: "https://login.microsoftonline.com/nuriteo/v2.0",
    linkedIdentityCount: 42,
    secretVersion: 3,
    state: "active",
    updatedAt: "2026-10-20T01:00:00.000Z"
  },
  {
    clientId: "nuriteo-staging",
    configVersion: 2,
    createdAt: "2026-10-18T01:00:00.000Z",
    displayName: "Google Workspace",
    id: fixtureId(6_502),
    issuer: "https://accounts.google.com",
    linkedIdentityCount: 0,
    secretVersion: 1,
    state: "disabled",
    updatedAt: "2026-10-21T01:00:00.000Z"
  }
];

export const registryConfiguration: RegistryConfiguration = {
  items: [
    {
      baseUrl: "https://registry.nuriteo.dev/npm/",
      configVersion: 7,
      credentialVersion: 4,
      displayName: "누리터 패키지 저장소",
      id: fixtureId(6_601),
      isDefault: true,
      state: "active",
      validatedAt: "2026-10-22T00:40:00.000Z"
    },
    {
      baseUrl: "https://packages.partner.dev/npm/",
      configVersion: 2,
      credentialVersion: 1,
      displayName: "파트너 패키지 저장소",
      id: fixtureId(6_602),
      isDefault: false,
      state: "disabled",
      validatedAt: null
    }
  ],
  scopes: [
    { connectionId: fixtureId(6_601), scope: "@nuriteo" },
    { connectionId: fixtureId(6_602), scope: "@partner" }
  ]
};

export const gitProviders: readonly GitProviderAdmin[] = [
  {
    allowsRead: true,
    allowsWrite: true,
    apiBaseUrl: "https://github.nuriteo.dev/api/v3",
    configVersion: 5,
    displayName: "GitHub Enterprise",
    host: "github.nuriteo.dev",
    id: fixtureId(6_701),
    kind: "github_enterprise",
    oauthAuthorizationUrl: "https://github.nuriteo.dev/login/oauth/authorize",
    oauthClientId: "nuriteo-web",
    oauthTokenUrl: "https://github.nuriteo.dev/login/oauth/access_token",
    port: 443,
    state: "active",
    validatedAt: "2026-10-22T00:45:00.000Z"
  },
  {
    allowsRead: true,
    allowsWrite: false,
    apiBaseUrl: "https://gitlab.partner.dev/api/v4",
    configVersion: 2,
    displayName: "파트너 GitLab",
    host: "gitlab.partner.dev",
    id: fixtureId(6_702),
    kind: "gitlab_self_managed",
    oauthAuthorizationUrl: null,
    oauthClientId: null,
    oauthTokenUrl: null,
    port: 443,
    state: "disabled",
    validatedAt: null
  }
];

export const emailDeliveries: EmailDeliveryCollection = {
  items: Array.from({ length: 25 }, (_, index) => ({
    attemptCount: 3 + (index % 6),
    availableAt: new Date(Date.UTC(2026, 9, 22, 2 + (index % 4), index)).toISOString(),
    classification: index % 3 === 0 ? "critical_security" : "account_access",
    errorClass: index % 4 === 0 ? "ambiguous" : "permanent",
    id: fixtureId(6_800 + index),
    recipientEmail: `user${index + 1}@example.dev`,
    resourceId: fixtureId(6_900 + index),
    resourceType: "user",
    smtpCode: index % 4 === 0 ? 451 : 550,
    state: "dead_letter",
    templateId: index % 2 === 0 ? "identity.password_changed" : "security.new_sign_in",
    updatedAt: new Date(Date.UTC(2026, 9, 22, 3 + (index % 4), index)).toISOString(),
    version: 1 + (index % 3)
  })),
  nextCursor: null,
  smtpConfigured: true
};

export const smtpCaCollection: IntegrationCaCollection = {
  items: [
    {
      earliestExpiry: "2027-10-22T01:00:00.000Z",
      fingerprints: ["a".repeat(64)],
      id: fixtureId(6_951),
      integrationId: "default",
      integrationType: "smtp",
      state: "active",
      version: 3
    },
    {
      earliestExpiry: "2028-04-12T01:00:00.000Z",
      fingerprints: ["b".repeat(64)],
      id: fixtureId(6_952),
      integrationId: "default",
      integrationType: "smtp",
      state: "candidate",
      version: 4
    }
  ],
  version: 4
};

function numberSetting(
  key: string,
  value: number,
  minimum: number,
  maximum: number,
  policyCategory: "audit" | "notification" | "security" | "token"
) {
  return {
    applyMode: "live" as const,
    constraint: { kind: "unsigned_integer" as const, maximum, minimum },
    defaultValue: value,
    key,
    policyCategory,
    value,
    version: 3
  };
}

function invitation(
  index: number,
  email: string,
  status: ActivationInvitation["status"],
  expiresAt: string
): ActivationInvitation {
  return {
    accepted_at: status === "accepted" ? "2026-10-20T01:00:00.000Z" : null,
    created_at: "2026-10-15T01:00:00.000Z",
    email,
    expires_at: expiresAt,
    id: fixtureId(index),
    replacement_id: null,
    revoked_at: status === "revoked" ? "2026-10-18T01:00:00.000Z" : null,
    status,
    superseded_at: null
  };
}

function fixtureId(index: number): string {
  return `0199ee6c-c777-7000-8000-${String(index).padStart(12, "0")}`;
}
