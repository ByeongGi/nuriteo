"use client";

import { deleteSession } from "@nuriteo/api-client";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "#src/components/ui/button.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";

export function LogoutButton() {
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

  return (
    <div className="authenticated-navigation__logout">
      <Button
        aria-describedby={error ? "logout-error" : undefined}
        disabled={isPending}
        onClick={() => void logout()}
        size="sm"
        type="button"
        variant="ghost"
      >
        <span aria-hidden="true">↪</span>
        <span>{isPending ? "로그아웃 중…" : "로그아웃"}</span>
      </Button>
      {error ? <p id="logout-error" role="alert">{error}</p> : null}
    </div>
  );
}
