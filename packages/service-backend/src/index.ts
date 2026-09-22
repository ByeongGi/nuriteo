export { SERVICE_BACKEND_SCHEMA_VERSION } from "./types.ts";
export type {
  AccessMode,
  AuthSession,
  ProjectExportBundle,
  ProjectMetadata,
  ProjectPermission,
  ProjectSnapshot,
  ProjectSnapshotFile,
  SchemaExtensions,
  ServiceBackendPersistenceState,
  ShareAccessMode,
  ShareLink,
  UsageMeterSnapshot,
  UserAccount
} from "./types.ts";

export { ServiceBackendError } from "./errors.ts";
export type { ServiceBackendErrorCode } from "./errors.ts";

export { createId, createToken, resetIdSequence } from "./ids.ts";

export { LocalFirstProjectStore } from "./store.ts";
export type { LocalFirstProjectStoreOptions } from "./store.ts";

export {
  FILE_REMOTE_BACKUP_SCHEMA_VERSION,
  FileRemoteBackup,
  InMemoryRemoteBackup
} from "./remote-backup.ts";
export type {
  FileRemoteBackupOptions,
  RemoteBackupAdapter
} from "./remote-backup.ts";

export { InMemoryUsageMeter } from "./usage-meter.ts";
export type { UsageMeter } from "./usage-meter.ts";

export { AuthService } from "./auth.ts";
export type { AuthServiceOptions } from "./auth.ts";

export { ProjectService } from "./project-service.ts";
export type { ProjectServiceOptions } from "./project-service.ts";

export { ShareService } from "./share-service.ts";
export type { ResolvedShare, ShareServiceOptions } from "./share-service.ts";

export { HmacSessionIdentityProvider, FileProductionDatabase, FileProductionObjectStorage } from "./production-adapters.ts";
export { ProductionServiceBackend } from "./production-service.ts";
export { handleProductionApi } from "./production-api.ts";
export type { ProductionApiRequest, ProductionApiResponse } from "./production-api.ts";
export type {
  AuditEvent,
  CloudProjectRecord,
  CloudProjectSnapshot,
  CloudShareRecord,
  IdentityPrincipal,
  IdentityProviderAdapter,
  ProductionBackendOptions,
  ProductionDatabaseAdapter,
  ProductionObjectStorageAdapter,
  UsageEvent
} from "./production-types.ts";

import { AuthService } from "./auth.ts";
import { InMemoryRemoteBackup } from "./remote-backup.ts";
import { ProjectService } from "./project-service.ts";
import { ShareService } from "./share-service.ts";
import { LocalFirstProjectStore } from "./store.ts";
import { InMemoryUsageMeter } from "./usage-meter.ts";
import type { RemoteBackupAdapter } from "./remote-backup.ts";
import type { LocalFirstProjectStoreOptions } from "./store.ts";
import type { UsageMeter } from "./usage-meter.ts";

export interface ServiceBackend {
  store: LocalFirstProjectStore;
  auth: AuthService;
  projects: ProjectService;
  shares: ShareService;
  usage: UsageMeter;
  remoteBackup: RemoteBackupAdapter;
}

export interface CreateServiceBackendOptions extends LocalFirstProjectStoreOptions {
  remoteBackup?: RemoteBackupAdapter;
  usageMeter?: UsageMeter;
  enableRemoteBackup?: boolean;
}

/**
 * Wire a private-beta backend with a local-first store. Backup defaults to the
 * in-memory adapter; inject FileRemoteBackup for single-node restart recovery.
 */
export function createServiceBackend(
  options: CreateServiceBackendOptions = {}
): ServiceBackend {
  const storeOptions: LocalFirstProjectStoreOptions = {};
  if (options.persistPath !== undefined) storeOptions.persistPath = options.persistPath;
  if (options.now !== undefined) storeOptions.now = options.now;
  const store = new LocalFirstProjectStore(storeOptions);
  const remoteBackup = options.remoteBackup ?? new InMemoryRemoteBackup();
  const usage = options.usageMeter ?? new InMemoryUsageMeter();
  const auth = new AuthService({ store });
  const projectOptions: {
    store: LocalFirstProjectStore;
    remoteBackup: RemoteBackupAdapter;
    usageMeter: UsageMeter;
    enableRemoteBackup?: boolean;
  } = { store, remoteBackup, usageMeter: usage };
  if (options.enableRemoteBackup !== undefined) {
    projectOptions.enableRemoteBackup = options.enableRemoteBackup;
  }
  const projects = new ProjectService(projectOptions);
  const shares = new ShareService({ store, projects });
  return { store, auth, projects, shares, usage, remoteBackup };
}
