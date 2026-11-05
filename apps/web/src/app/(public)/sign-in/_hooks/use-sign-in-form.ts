"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { signInSchema } from "@/app/(public)/sign-in/_schema/sign-in.ts";
import { safeReturnTo } from "@/app/(public)/sign-in/_utils/return-to.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import {
  classifySignInFailure,
  safeRequestReference
} from "@/lib/api/presentation-error.ts";
import {
  createSession,
  getCurrentUser
} from "@/services/session/api.ts";

import type { FormEvent } from "react";

interface SignInErrorState {
  readonly message: string;
  readonly reference?: string | undefined;
}

class SignInValidationError extends Error {}

function presentSignInError(cause: unknown): SignInErrorState {
  if (cause instanceof SignInValidationError) {
    return { message: cause.message };
  }

  const kind = classifySignInFailure(cause);
  return {
    message:
      kind === "invalid-credentials"
        ? "이메일 또는 비밀번호를 다시 확인하세요."
        : "현재 로그인할 수 없습니다. 잠시 후 다시 시도하세요.",
    reference: safeRequestReference(cause)
  };
}

export function useSignInForm(returnTo: string) {
  const router = useRouter();
  const passwordInput = useRef<HTMLInputElement>(null);
  const destination = safeReturnTo(returnTo);
  const signIn = useMutation({
    mutationFn: async (formData: FormData) => {
      const parsed = signInSchema.safeParse({
        email: formData.get("email"),
        password: formData.get("password")
      });
      if (!parsed.success) {
        throw new SignInValidationError(parsed.error.issues[0]?.message ?? "이메일과 비밀번호를 입력한 뒤 다시 시도하세요.");
      }

      const { email, password } = parsed.data;
      const client = createBrowserApiClient();
      await createSession(client, { email, password });
      await getCurrentUser(client);
    },
    onError: () => {
      if (passwordInput.current) {
        passwordInput.current.value = "";
      }
      passwordInput.current?.focus();
    },
    onSuccess: () => {
      router.replace(destination);
      router.refresh();
    }
  });
  const error = signIn.error ? presentSignInError(signIn.error) : undefined;

  useEffect(() => {
    if (signIn.isError) {
      passwordInput.current?.focus();
    }
  }, [signIn.isError]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (signIn.isPending) {
      return;
    }

    signIn.mutate(new FormData(event.currentTarget));
  }

  return {
    destination,
    error,
    handleSubmit,
    isPending: signIn.isPending,
    passwordInput
  };
}
