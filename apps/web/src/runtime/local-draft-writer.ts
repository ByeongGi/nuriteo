const TAKEOVER_TIMEOUT_MS = 3_000;
const CHANNEL_PREFIX = "nuriteo-local-draft-writer";
const LOCK_PREFIX = "nuriteo:local-draft:";

interface TakeoverMessage {
  namespace: string;
  type: "takeover-request";
}

export interface LocalDraftWriterLease {
  readonly status: "writer" | "conflict" | "lost" | "released";
  acquire(): Promise<boolean>;
  takeOver(): Promise<void>;
  release(): Promise<void>;
}

export interface LocalDraftWriterLeaseOptions {
  namespace: string;
  onLost(): void;
  takeoverTimeoutMs?: number;
}

interface LockManagerLike {
  request(
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => Promise<void>
  ): Promise<void>;
}

export function createLocalDraftWriterLease(options: LocalDraftWriterLeaseOptions): LocalDraftWriterLease {
  return new BrowserLocalDraftWriterLease(options);
}

class BrowserLocalDraftWriterLease implements LocalDraftWriterLease {
  readonly #channel: BroadcastChannel;
  readonly #lockManager: LockManagerLike;
  readonly #lockName: string;
  readonly #namespace: string;
  readonly #onLost: () => void;
  readonly #takeoverTimeoutMs: number;
  #holdPromise: Promise<void> | null = null;
  #pendingAbortController: AbortController | null = null;
  #releaseHold: (() => void) | null = null;
  #status: LocalDraftWriterLease["status"] = "released";

  constructor(options: LocalDraftWriterLeaseOptions) {
    if (!options.namespace || options.namespace.length > 256) {
      throw new Error("Local Draft namespace is invalid.");
    }
    if (!globalThis.navigator?.locks || typeof globalThis.BroadcastChannel !== "function") {
      throw new Error("This browser cannot coordinate Local Draft writers safely.");
    }
    this.#namespace = options.namespace;
    this.#lockName = `${LOCK_PREFIX}${options.namespace}`;
    this.#lockManager = globalThis.navigator.locks;
    this.#onLost = options.onLost;
    this.#takeoverTimeoutMs = options.takeoverTimeoutMs ?? TAKEOVER_TIMEOUT_MS;
    this.#channel = new BroadcastChannel(`${CHANNEL_PREFIX}:${options.namespace}`);
    this.#channel.addEventListener("message", this.#handleMessage);
  }

  get status(): LocalDraftWriterLease["status"] {
    return this.#status;
  }

  async acquire(): Promise<boolean> {
    if (this.#status === "writer") return true;
    const acquired = await this.#request({ ifAvailable: true, mode: "exclusive" });
    this.#status = acquired ? "writer" : "conflict";
    return acquired;
  }

  async takeOver(): Promise<void> {
    if (this.#status === "writer") return;
    this.#channel.postMessage({ namespace: this.#namespace, type: "takeover-request" } satisfies TakeoverMessage);
    const abortController = new AbortController();
    this.#pendingAbortController = abortController;
    const timeout = setTimeout(() => abortController.abort(), this.#takeoverTimeoutMs);
    try {
      const acquired = await this.#request({ mode: "exclusive", signal: abortController.signal });
      if (!acquired) throw new Error("The Local Draft writer lease was not acquired.");
      this.#status = "writer";
    } catch {
      this.#status = "conflict";
      throw new Error("The other tab did not release the Local Draft writer lease. Close it or retry takeover.");
    } finally {
      clearTimeout(timeout);
      if (this.#pendingAbortController === abortController) this.#pendingAbortController = null;
    }
  }

  async release(): Promise<void> {
    this.#channel.removeEventListener("message", this.#handleMessage);
    this.#channel.close();
    this.#pendingAbortController?.abort();
    this.#pendingAbortController = null;
    this.#releaseHold?.();
    try {
      await this.#holdPromise;
    } catch {
      // A cancelled waiter owns no lock and has nothing else to release.
    }
    this.#holdPromise = null;
    this.#releaseHold = null;
    this.#status = "released";
  }

  readonly #handleMessage = (event: MessageEvent<unknown>): void => {
    const message = event.data;
    if (!isTakeoverMessage(message, this.#namespace) || this.#status !== "writer") return;
    this.#status = "lost";
    this.#releaseHold?.();
    this.#onLost();
  };

  async #request(lockOptions: LockOptions): Promise<boolean> {
    if (this.#holdPromise) {
      await this.#holdPromise.catch(() => undefined);
      this.#holdPromise = null;
    }

    let decided = false;
    let resolveDecision!: (acquired: boolean) => void;
    const decision = new Promise<boolean>((resolve) => {
      resolveDecision = (acquired) => {
        if (decided) return;
        decided = true;
        resolve(acquired);
      };
    });
    const hold = new Promise<void>((resolve) => { this.#releaseHold = resolve; });
    this.#holdPromise = this.#lockManager.request(this.#lockName, lockOptions, async (lock) => {
      if (!lock) {
        this.#releaseHold = null;
        resolveDecision(false);
        return;
      }
      resolveDecision(true);
      await hold;
    });
    void this.#holdPromise.catch(() => resolveDecision(false));
    return decision;
  }
}

function isTakeoverMessage(value: unknown, namespace: string): value is TakeoverMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<TakeoverMessage>;
  return message.type === "takeover-request" && message.namespace === namespace;
}
