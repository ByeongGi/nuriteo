"use client";

import { deleteSession } from "@nuriteo/api-client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { tv } from "tailwind-variants";

import { Button } from "#src/components/ui/button.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";

const logoutButtonStyles = tv({
  slots: {
    root: "mt-auto grid gap-1 pt-4",
    button: "w-full justify-start gap-2 text-muted-foreground hover:text-foreground",
    error: "m-0 text-xs leading-snug text-danger"
  },
  variants: {
    placement: {
      sidebar: {
        root: "max-[48rem]:hidden"
      },
      mobile: {
        root: "m-0 block p-0",
        button: "min-h-11 justify-start px-3"
      },
      header: {
        root: "m-0 block p-0 max-[40rem]:hidden",
        button: "min-h-9 w-auto justify-center px-3"
      }
    }
  },
  defaultVariants: {
    placement: "sidebar"
  }
});

export function LogoutButton({ placement = "sidebar" }: Readonly<{ placement?: "sidebar" | "mobile" | "header" }>) {
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

  const styles = logoutButtonStyles({ placement });

  return (
    <div className={styles.root()} data-slot="logout-action">
      <Button
        aria-describedby={error ? "logout-error" : undefined}
        disabled={isPending}
        onClick={() => void logout()}
        size="sm"
        type="button"
        variant="ghost"
        className={styles.button()}
      >
        <span aria-hidden="true">↪</span>
        <span>{isPending ? "로그아웃 중…" : "로그아웃"}</span>
      </Button>
      {error ? <p className={styles.error()} id="logout-error" role="alert">{error}</p> : null}
    </div>
  );
}
