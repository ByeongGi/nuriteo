"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { activateInvitedAccount } from "@/services/activation/api.ts";
import { activationSchema } from "@/app/(public)/activate/_schema/activation.ts";
import { collaborationError } from "@/lib/api/browser-security.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";

import type { FormEvent } from "react";

export function useActivationForm(activationToken: string | null | undefined) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const mutation = useExclusiveMutation();
  const [error, setError] = useState<string>();
  const token = activationToken === undefined ? searchParams.get("token") : activationToken;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (token === null) {
      setError("활성화 링크가 없거나 올바르지 않습니다.");
      return;
    }
    const parsed = activationSchema.safeParse({
      token,
      email: String(data.get("email") ?? ""),
      displayName: String(data.get("displayName") ?? ""),
      password: String(data.get("password") ?? "")
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "입력값을 확인하세요.");
      return;
    }
    await mutation.run(async () => {
      setError(undefined);
      try {
        await activateInvitedAccount(createBrowserApiClient(), parsed.data);
        form.reset();
        router.replace("/sign-in?activated=1");
      } catch (cause) {
        setError(collaborationError(cause, "activation-invitation-terminal"));
      }
    });
  }

  return {
    error,
    handleSubmit,
    isPending: mutation.isPending,
    token
  };
}
