"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { deleteSession } from "@/services/session/api.ts";

export function useLogoutButton() {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string>();

  async function logout() {
    if (isPending) return;
    setError(undefined);
    setIsPending(true);
    try {
      await deleteSession(createBrowserApiClient(), {
        csrfToken: readCsrfCredential()
      });
      router.replace("/sign-in");
      router.refresh();
    } catch {
      setError("로그아웃하지 못했습니다. 연결을 확인하고 다시 시도하세요.");
      setIsPending(false);
    }
  }

  return { error, isPending, logout };
}
