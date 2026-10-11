import { createMemoryOpfs } from "../../browser-host/src/storage/opfs.ts";
import {
  createQuotaManagedOpfs,
  QuotaManagedOpfs,
  StorageQuotaError
} from "../../browser-host/src/storage/quota.ts";
import {
  createStorageLease,
  StorageLease,
  StorageLeaseError
} from "../../browser-host/src/storage/lease.ts";
import type { StorageLeaseHandle, StorageQuotaUsage } from "../../browser-host/src/storage/types.ts";
import {
  createRuntimeRecoveryActionExecutor,
  type RuntimeRecoveryActionExecutor
} from "../../browser-host/src/observability/recovery-action-executor.ts";
import {
  createRuntimeRecoveryPlan,
  type RuntimeRecoveryAction,
  type RuntimeRecoveryPlan
} from "../../browser-host/src/observability/recovery-actions.ts";
import type { RuntimeDiagnostic } from "../../browser-host/src/observability/support-bundle.ts";
import {
  assertAbuseAllowed,
  createAbuseLimitPolicy,
  type AbuseLimitPolicy
} from "../../browser-host/src/security/abuse-limits.ts";

export interface PreviewReliabilityPolicy {
  storage: {
    quotaBytesDefault: number;
    evictionPrefixes: string[];
    protectedPrefixes: string[];
    writerLeaseTtlMs: number;
  };
}

export interface PreviewReliabilitySession {
  storage: QuotaManagedOpfs;
  lease: StorageLease;
  writer: StorageLeaseHandle | null;
  owner: string;
  lastQuotaUsage: StorageQuotaUsage | null;
  abusePolicy: AbuseLimitPolicy;
  acquireWriter(): StorageLeaseHandle;
  releaseWriter(): void;
  forceTakeWriter(): StorageLeaseHandle;
  clearPackageCache(): { freedBytes: number; evicted: number };
  writeCacheFile(path: string, value: unknown): void;
  guardMemoryGrowth(bytes: number): void;
  guardLoopIterations(iterations: number): void;
  handleStorageError(error: unknown): RuntimeDiagnostic | null;
  createRecoveryPlan(diagnostics: RuntimeDiagnostic[]): RuntimeRecoveryPlan;
  createRecoveryExecutor(handlers: {
    clearCache?: () => unknown;
    resetRuntime?: () => unknown;
    resolveWriterConflict?: () => unknown;
    retry?: (action: RuntimeRecoveryAction) => unknown;
  }): RuntimeRecoveryActionExecutor;
}

const defaultPolicy: PreviewReliabilityPolicy = {
  storage: {
    quotaBytesDefault: 268435456,
    evictionPrefixes: ["cache/", "packages/"],
    protectedPrefixes: ["projects/"],
    writerLeaseTtlMs: 30000
  }
};

export function createPreviewReliabilitySession(
  options: {
    owner?: string;
    policy?: PreviewReliabilityPolicy;
    abusePolicy?: Partial<AbuseLimitPolicy>;
  } = {}
): PreviewReliabilitySession {
  const policy = options.policy || defaultPolicy;
  const owner = options.owner || `preview-tab-${Math.random().toString(16).slice(2)}`;
  const storage = createQuotaManagedOpfs({
    opfs: createMemoryOpfs(),
    quotaBytes: policy.storage.quotaBytesDefault,
    evictionPrefixes: policy.storage.evictionPrefixes,
    protectedPrefixes: policy.storage.protectedPrefixes
  });
  const lease = createStorageLease({ ttlMs: policy.storage.writerLeaseTtlMs });
  const abusePolicy = createAbuseLimitPolicy(options.abusePolicy);
  let writer: StorageLeaseHandle | null = null;
  let lastQuotaUsage: StorageQuotaUsage | null = null;

  function acquireWriter(): StorageLeaseHandle {
    writer = lease.acquire(owner);
    return writer;
  }

  function releaseWriter(): void {
    if (!writer) return;
    try {
      lease.release(owner);
    } finally {
      writer = null;
    }
  }

  function forceTakeWriter(): StorageLeaseHandle {
    if (lease.owner && lease.owner !== owner) {
      lease.owner = null;
      lease.expiresAt = 0;
    } else if (lease.owner === owner) {
      try {
        lease.release(owner);
      } catch {
        lease.owner = null;
        lease.expiresAt = 0;
      }
    }
    writer = null;
    return acquireWriter();
  }

  function clearPackageCache(): { freedBytes: number; evicted: number } {
    const result = storage.evict({
      prefixes: policy.storage.evictionPrefixes,
      requiredBytes: 0
    });
    lastQuotaUsage = result.after;
    return { freedBytes: result.freedBytes, evicted: result.evicted.length };
  }

  function writeCacheFile(path: string, value: unknown): void {
    const encoded = typeof value === "string" ? value : JSON.stringify(value);
    guardMemoryGrowth(encoded.length);
    storage.writeFile(path, value as never);
  }

  function guardMemoryGrowth(bytes: number): void {
    assertAbuseAllowed({
      kind: "memory-growth",
      memoryGrowthBytes: (lastQuotaUsage?.usedBytes || storage.usage().usedBytes) + bytes
    }, abusePolicy);
  }

  function guardLoopIterations(iterations: number): void {
    assertAbuseAllowed({ kind: "loop", loopIterations: iterations }, abusePolicy);
  }

  function handleStorageError(error: unknown): RuntimeDiagnostic | null {
    if (error instanceof StorageQuotaError) {
      lastQuotaUsage = error.usage;
      return {
        code: error.code,
        severity: "error",
        message: error.message,
        source: "storage",
        remediation: "Clear package cache and retry the operation."
      };
    }
    if (error instanceof StorageLeaseError) {
      return {
        code: error.code,
        severity: "error",
        message: error.message,
        source: "storage",
        remediation: "Resolve the multi-tab writer conflict before saving or installing."
      };
    }
    return null;
  }

  function createRecoveryPlan(diagnostics: RuntimeDiagnostic[]): RuntimeRecoveryPlan {
    return createRuntimeRecoveryPlan({ diagnostics });
  }

  function createRecoveryExecutor(handlers: {
    clearCache?: () => unknown;
    resetRuntime?: () => unknown;
    resolveWriterConflict?: () => unknown;
    retry?: (action: RuntimeRecoveryAction) => unknown;
  }): RuntimeRecoveryActionExecutor {
    return createRuntimeRecoveryActionExecutor({
      handlers: {
        clearCache: () => handlers.clearCache?.() ?? clearPackageCache(),
        resetRuntime: () => handlers.resetRuntime?.(),
        resolveWriterConflict: () => handlers.resolveWriterConflict?.() ?? forceTakeWriter(),
        retry: (action) => handlers.retry?.(action)
      }
    });
  }

  return {
    storage,
    lease,
    get writer() {
      return writer;
    },
    owner,
    get lastQuotaUsage() {
      return lastQuotaUsage;
    },
    abusePolicy,
    acquireWriter,
    releaseWriter,
    forceTakeWriter,
    clearPackageCache,
    writeCacheFile,
    guardMemoryGrowth,
    guardLoopIterations,
    handleStorageError,
    createRecoveryPlan,
    createRecoveryExecutor
  };
}
