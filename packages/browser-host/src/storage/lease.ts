export class StorageLeaseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "StorageLeaseError";
    this.code = code;
  }
}

export class StorageLease {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.ttlMs = options.ttlMs ?? 30000;
    this.owner = null;
    this.expiresAt = 0;
  }

  acquire(owner) {
    if (this.owner && this.expiresAt > this.now() && this.owner !== owner) {
      throw new StorageLeaseError(`storage writer lease held by ${this.owner}`, "ELEASEHELD");
    }
    this.owner = owner;
    this.expiresAt = this.now() + this.ttlMs;
    return { owner, expiresAt: this.expiresAt };
  }

  assert(owner) {
    if (this.owner !== owner || this.expiresAt <= this.now()) {
      throw new StorageLeaseError("storage writer lease is not active", "ELEASEMISSING");
    }
  }

  release(owner) {
    this.assert(owner);
    this.owner = null;
    this.expiresAt = 0;
  }
}

export function createStorageLease(options) {
  return new StorageLease(options);
}

