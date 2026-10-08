"use client";

import { createSession, getCurrentUser } from "@nuriteo/api-client";
import type { OidcLoginProvider } from "@nuriteo/api-client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { Button } from "../../components/ui/button.tsx";
import { createBrowserApiClient } from "../../lib/api/browser-client.ts";
import {
  classifySignInFailure,
  safeRequestReference
} from "../../lib/api/presentation-error.ts";

interface SignInErrorState {
  readonly message: string;
  readonly reference?: string | undefined;
}

export function SignInForm({ providers = [], oidcFailed = false }: { readonly providers?: readonly OidcLoginProvider[]; readonly oidcFailed?: boolean }) {
  const router = useRouter();
  const passwordInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<SignInErrorState>();
  const [isPending, setIsPending] = useState(false);

  useEffect(() => {
    if (error !== undefined) {
      passwordInput.current?.focus();
    }
  }, [error]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPending) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const email = formData.get("email");
    const password = formData.get("password");
    if (typeof email !== "string" || typeof password !== "string") {
      setError({ message: "Enter your email and password, then try again." });
      passwordInput.current?.focus();
      return;
    }

    setError(undefined);
    setIsPending(true);
    try {
      const client = createBrowserApiClient();
      await createSession(client, { email, password });
      await getCurrentUser(client);
      router.replace("/workspaces");
      router.refresh();
    } catch (cause) {
      const kind = classifySignInFailure(cause);
      setError({
        message:
          kind === "invalid-credentials"
            ? "The email or password is incorrect."
            : "Sign-in is temporarily unavailable. Try again.",
        reference: safeRequestReference(cause)
      });
      if (passwordInput.current) {
        passwordInput.current.value = "";
      }
      setIsPending(false);
    }
  }

  return (
    <main id="main-content" className="entry-page" tabIndex={-1}>
      <section className="entry-card entry-card--compact" aria-labelledby="sign-in-title">
        <p className="eyebrow">Welcome back</p>
        <h1 id="sign-in-title">Sign in to NURITEO</h1>
        <p className="entry-description">Use the local account provided by your administrator.</p>

        {oidcFailed ? <div className="form-error" role="alert"><p>Identity-provider sign-in could not be completed. Try that Provider again or use your local account.</p></div> : null}

        {providers.length > 0 ? (
          <div className="sign-in-form" aria-label="Identity provider sign-in">
            {providers.map((provider) => (
              <Button key={provider.id} render={<a href={`/api/v1/auth/oidc/${provider.id}/begin`} />}>
                Continue with {provider.displayName}
              </Button>
            ))}
            <p className="entry-description">Or use your local account.</p>
          </div>
        ) : null}

        <form className="sign-in-form" onSubmit={handleSubmit} aria-busy={isPending}>
          <div className="field-group">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              inputMode="email"
              maxLength={320}
              required
              disabled={isPending}
            />
          </div>

          <div className="field-group">
            <label htmlFor="password">Password</label>
            <input
              ref={passwordInput}
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              disabled={isPending}
              aria-describedby={error ? "sign-in-error" : undefined}
            />
          </div>

          {error ? (
            <div id="sign-in-error" className="form-error" role="alert" aria-live="polite">
              <p>{error.message}</p>
              {error.reference ? <p>Request reference: {error.reference}</p> : null}
            </div>
          ) : null}

          <Button type="submit" variant="primary" disabled={isPending}>
            {isPending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </section>
    </main>
  );
}
