export interface RetryableLazyFeature<T> {
  load(): Promise<T>;
  reset(): void;
}

export function createRetryableLazyFeature<T>(loadFeature: () => Promise<T>): RetryableLazyFeature<T> {
  let pending: Promise<T> | null = null;

  return {
    load() {
      if (pending) return pending;
      const attempt = Promise.resolve().then(loadFeature);
      const guarded = attempt.catch((error: unknown) => {
        if (pending === guarded) pending = null;
        throw error;
      });
      pending = guarded;
      return pending;
    },
    reset() {
      pending = null;
    }
  };
}
