"use client";

import { useCallback, useRef, useState } from "react";

interface ExclusiveMutation {
  readonly isPending: boolean;
  run(action: () => Promise<void>): Promise<boolean>;
}

export function useExclusiveMutation(): ExclusiveMutation {
  const locked = useRef(false);
  const [isPending, setIsPending] = useState(false);

  const run = useCallback(async (action: () => Promise<void>): Promise<boolean> => {
    if (locked.current) return false;
    locked.current = true;
    setIsPending(true);
    try {
      await action();
      return true;
    } finally {
      locked.current = false;
      setIsPending(false);
    }
  }, []);

  return { isPending, run };
}
