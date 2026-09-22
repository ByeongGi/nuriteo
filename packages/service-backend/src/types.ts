/** Schema version for private-beta service backend records. */
export const SERVICE_BACKEND_SCHEMA_VERSION = 1 as const;

export type AccessMode = "private" | "read_only" | "forkable";

export type ShareAccessMode = Exclude<AccessMode, "private">;

/**
 * Reserved extension hooks for post-beta team/permissions.
 * Beta stores ignore unknown keys; later phases may promote fields.
 */
export type SchemaExtensions = Record<string, unknown>;

export interface UserAccount {
  schemaVersion: typeof SERVICE_BACKEND_SCHEMA_VERSION;
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  /** Future: org membership, roles, SSO subject. */
  extensions?: SchemaExtensions;
}

export interface ProjectPermission {
  principalId: string;
  role: "owner" | "editor" | "viewer";
}

export interface ProjectMetadata {
  schemaVersion: typeof SERVICE_BACKEND_SCHEMA_VERSION;
  id: string;
  ownerId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Null until team projects ship; kept for schema extensibility. */
  teamId?: string | null;
  /** Empty in beta; shape reserved for ACL expansion. */
  permissions?: ProjectPermission[];
  extensions?: SchemaExtensions;
}

export interface ProjectSnapshotFile {
  path: string;
  content: string;
}

export interface ProjectSnapshot {
  schemaVersion: typeof SERVICE_BACKEND_SCHEMA_VERSION;
  projectId: string;
  generation: number;
  files: ProjectSnapshotFile[];
  savedAt: string;
  byteSize: number;
  extensions?: SchemaExtensions;
}

export interface ShareLink {
  schemaVersion: typeof SERVICE_BACKEND_SCHEMA_VERSION;
  id: string;
  token: string;
  projectId: string;
  accessMode: ShareAccessMode;
  createdBy: string;
  createdAt: string;
  revokedAt?: string | null;
  extensions?: SchemaExtensions;
}

export interface ProjectExportBundle {
  schemaVersion: typeof SERVICE_BACKEND_SCHEMA_VERSION;
  kind: "cargo-container.project-export";
  exportedAt: string;
  metadata: ProjectMetadata;
  snapshot: ProjectSnapshot | null;
}

export interface UsageMeterSnapshot {
  storageBytes: number;
  installCount: number;
  runtimeMinutes: number;
}

export interface AuthSession {
  userId: string;
  email: string;
  token: string;
  createdAt: string;
}

export interface ServiceBackendPersistenceState {
  schemaVersion: typeof SERVICE_BACKEND_SCHEMA_VERSION;
  users: UserAccount[];
  projects: ProjectMetadata[];
  snapshots: ProjectSnapshot[];
  shareLinks: ShareLink[];
  sessions: AuthSession[];
  usageByUser: Record<string, UsageMeterSnapshot>;
}
