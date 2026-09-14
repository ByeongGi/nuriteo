import type { StorageLeaseErrorCode, StorageLeaseHandle, StorageLeaseOptions } from "./types.ts";

export class StorageLeaseError extends Error {
  code: StorageLeaseErrorCode;

  constructor(message: string, code: StorageLeaseErrorCode) {
    super(message);
    this.name = "StorageLeaseError";
    this.code = code;
  }
}

export class StorageLease {
  now: () => number;
  ttlMs: number;
  owner: string | null;
  expiresAt: number;

  constructor(options: StorageLeaseOptions = {}) {
    this.now = options.now || (() => Date.now());
    this.ttlMs = options.ttlMs ?? 30000;
    this.owner = null;
    this.expiresAt = 0;
  }

  acquire(owner: string): StorageLeaseHandle {
    if (this.owner && this.expiresAt > this.now() && this.owner !== owner) {
      throw new StorageLeaseError(`storage writer lease held by ${this.owner}`, "ELEASEHELD");
    }
    this.owner = owner;
    this.expiresAt = this.now() + this.ttlMs;
    return { owner, expiresAt: this.expiresAt };
  }

  assert(owner: string): void {
    if (this.owner !== owner || this.expiresAt <= this.now()) {
      throw new StorageLeaseError("storage writer lease is not active", "ELEASEMISSING");
    }
  }

  release(owner: string): void {
    this.assert(owner);
    this.owner = null;
    this.expiresAt = 0;
  }
}

export function createStorageLease(options: StorageLeaseOptions = {}): StorageLease {
  return new StorageLease(options);
}
