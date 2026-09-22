import type { ProjectPermission, ProjectSnapshotFile, ShareAccessMode } from "./types.ts";

export interface IdentityPrincipal {
  tenantId: string;
  subject: string;
  email: string;
  displayName: string;
}

export interface IdentityProviderAdapter {
  verifySession(token: string): Promise<IdentityPrincipal | null>;
}

export interface CloudProjectRecord {
  id: string;
  tenantId: string;
  ownerId: string;
  name: string;
  generation: number;
  snapshotKey: string | null;
  permissions: ProjectPermission[];
  createdAt: string;
  updatedAt: string;
}

export interface CloudShareRecord {
  id: string;
  tenantId: string;
  projectId: string;
  tokenHash: string;
  accessMode: ShareAccessMode;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
  rotatedToId: string | null;
}

export interface AuditEvent {
  id: string;
  tenantId: string;
  actorId: string;
  action: string;
  resourceType: "project" | "share" | "usage" | "session";
  resourceId: string;
  at: string;
  detail?: Record<string, string | number | boolean | null>;
}

export interface UsageEvent {
  id: string;
  tenantId: string;
  actorId: string;
  kind: "storage_bytes" | "install" | "runtime_minutes";
  quantity: number;
  occurredAt: string;
}

export interface ProductionDatabaseAdapter {
  getProject(tenantId: string, projectId: string): Promise<CloudProjectRecord | null>;
  putProject(project: CloudProjectRecord): Promise<void>;
  listProjects(tenantId: string, principalId: string): Promise<CloudProjectRecord[]>;
  putShare(share: CloudShareRecord): Promise<void>;
  getShareById(tenantId: string, shareId: string): Promise<CloudShareRecord | null>;
  getShareByTokenHash(tokenHash: string): Promise<CloudShareRecord | null>;
  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(tenantId: string, resourceId?: string): Promise<AuditEvent[]>;
  ingestUsage(event: UsageEvent): Promise<boolean>;
  listUsage(tenantId: string, actorId: string): Promise<UsageEvent[]>;
}

export interface ProductionObjectStorageAdapter {
  putObject(key: string, bytes: Uint8Array): Promise<void>;
  getObject(key: string): Promise<Uint8Array | null>;
  deleteObject(key: string): Promise<void>;
}

export interface CloudProjectSnapshot {
  projectId: string;
  generation: number;
  files: ProjectSnapshotFile[];
  savedAt: string;
  byteSize: number;
}

export interface ProductionBackendOptions {
  identity: IdentityProviderAdapter;
  database: ProductionDatabaseAdapter;
  objects: ProductionObjectStorageAdapter;
  now?: () => number;
}
