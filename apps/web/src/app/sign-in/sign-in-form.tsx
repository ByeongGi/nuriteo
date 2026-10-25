"use client";

import { createSession, getCurrentUser } from "@nuriteo/api-client";
import type { OidcLoginProvider } from "@nuriteo/api-client";
import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import type { FormEvent } from "react";

import { Button } from "#src/components/ui/button.tsx";
import { Input } from "#src/components/ui/input.tsx";
import { signInStyles } from "#src/app/sign-in/sign-in.styles.ts";
import { SignInShell } from "#src/app/sign-in/sign-in-shell.tsx";
import { safeReturnTo, signInHref } from "#src/app/sign-in/return-to.ts";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import {
  classifySignInFailure,
  safeRequestReference
} from "#src/lib/api/presentation-error.ts";

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

interface SignInFormProps {
  readonly activated?: boolean;
  readonly oidcFailed?: boolean;
  readonly providers?: readonly OidcLoginProvider[];
  readonly providersLoadFailed?: boolean;
  readonly reauthentication?: boolean;
  readonly returnTo?: string;
}

export function SignInForm({
  activated = false,
  oidcFailed = false,
  providers = [],
  providersLoadFailed = false,
  reauthentication = false,
  returnTo = "/workspaces"
}: SignInFormProps) {
  const styles = signInStyles();
  const router = useRouter();
  const passwordInput = useRef<HTMLInputElement>(null);
  const destination = safeReturnTo(returnTo);
  const signIn = useMutation({
    mutationFn: async (formData: FormData) => {
      const email = formData.get("email");
      const password = formData.get("password");
      if (typeof email !== "string" || typeof password !== "string") {
        throw new SignInValidationError("이메일과 비밀번호를 입력한 뒤 다시 시도하세요.");
      }

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

  return (
    <SignInShell>
        {reauthentication ? (
          <div className={styles.status()} role="status">
            보안이 필요한 작업입니다. 계정을 다시 인증하면 원래 화면으로 돌아갑니다.
          </div>
        ) : null}
        {activated ? (
          <div className={styles.status()} role="status">
            계정 활성화를 완료했습니다. 새 계정으로 로그인하세요.
          </div>
        ) : null}

        {oidcFailed ? <div className={styles.error({ className: styles.oidcError() })} role="alert"><p>회사 계정 로그인을 완료하지 못했습니다. 다시 시도하거나 로컬 계정을 사용하세요.</p></div> : null}

        {providersLoadFailed ? (
          <div className={styles.providerError()} role="alert">
            <p>회사 계정 로그인 옵션을 불러오지 못했습니다. 로컬 계정으로 로그인하거나 다시 확인하세요.</p>
            <Button size="sm" render={<Link href={signInHref(destination)} />}>회사 로그인 다시 불러오기</Button>
          </div>
        ) : null}

        {providers.length > 0 ? (
          <div className={styles.oidc()} aria-label="OIDC 계정 로그인">
            {providers.map((provider) => (
              <Button className={styles.oidcButton()} key={provider.id} render={<a href={`/api/v1/auth/oidc/${provider.id}/begin?returnTo=${encodeURIComponent(destination)}`} />}>
                <span className={styles.providerMark()} aria-hidden="true">{provider.displayName.trim().charAt(0).toUpperCase()}</span>
                <span className={styles.providerLabel()}>{provider.displayName} 계정으로 계속</span>
              </Button>
            ))}
            <div className={styles.divider()}><span>또는 로컬 계정</span></div>
          </div>
        ) : null}

        <form className={styles.form()} onSubmit={handleSubmit} aria-busy={signIn.isPending}>
          <div className={styles.field()}>
            <label className={styles.label()} htmlFor="email">이메일</label>
            <Input
              className={styles.input()}
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              inputMode="email"
              maxLength={320}
              placeholder="name@company.com"
              required
              disabled={signIn.isPending}
            />
          </div>

          <div className={styles.field()}>
            <label className={styles.label()} htmlFor="password">비밀번호</label>
            <Input
              className={styles.input()}
              ref={passwordInput}
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              disabled={signIn.isPending}
              aria-describedby={error ? "sign-in-error" : "sign-in-password-help"}
              placeholder="비밀번호 입력"
            />
          </div>

          {error ? (
            <div id="sign-in-error" className={styles.error()} role="alert" aria-live="polite">
              <p>{error.message}</p>
              {error.reference ? <p>요청 참조: {error.reference}</p> : null}
            </div>
          ) : null}

          <Button className={styles.submitButton()} type="submit" variant="primary" disabled={signIn.isPending}>
            {signIn.isPending ? "로그인 중…" : "로그인"}
          </Button>
        </form>
    </SignInShell>
  );
}
