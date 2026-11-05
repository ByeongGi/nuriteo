"use client";

import { useState } from "react";

import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { previewAdminPolicyCleanup } from "@/services/admin/api.ts";

import type { AdminPolicyCleanupPreview } from "@nuriteo/api-client";

export function useCleanupPreview(initial: AdminPolicyCleanupPreview) {
  const mutation = useExclusiveMutation();
  const [preview, setPreview] = useState(initial);
  const [failure, setFailure] = useState(false);

  async function refresh() {
    await mutation.run(async () => {
      setFailure(false);
      try {
        const result = await previewAdminPolicyCleanup(createBrowserApiClient(), preview.batchLimit);
        setPreview(result.data);
      } catch {
        setFailure(true);
      }
    });
  }

  return { failure, mutation, preview, refresh };
}
