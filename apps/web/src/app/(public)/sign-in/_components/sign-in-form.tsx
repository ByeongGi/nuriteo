"use client";

import type { OidcLoginProvider } from "@nuriteo/api-client";
import Link from "next/link";

import { useSignInForm } from "@/app/(public)/sign-in/_hooks/use-sign-in-form.ts";
import { SignInShell } from "@/app/(public)/sign-in/_components/sign-in-shell.tsx";
import { signInStyles } from "@/app/(public)/sign-in/_components/sign-in.styles.ts";
import { signInHref } from "@/app/(public)/sign-in/_utils/return-to.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";

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
  const { destination, error, handleSubmit, isPending, passwordInput } = useSignInForm(returnTo);

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

        <form className={styles.form()} onSubmit={handleSubmit} aria-busy={isPending}>
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
              disabled={isPending}
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
              disabled={isPending}
              aria-describedby={error ? "sign-in-error" : "sign-in-password-help"}
              placeholder="비밀번호 입력"
            />
          </div>

          {error ? (
            <div id="sign-in-error" className={styles.error()} role="alert" aria-live="polite">
              <p>{error.message}</p>
              {(function () {
    if (error.reference) {
        return (<p>요청 참조: {error.reference}</p>);
    }
    return (null);
})()}
            </div>
          ) : null}

          <Button className={styles.submitButton()} type="submit" variant="primary" disabled={isPending}>
            {isPending ? "로그인 중…" : "로그인"}
          </Button>
        </form>
    </SignInShell>
  );
}
