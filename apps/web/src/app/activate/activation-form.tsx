"use client";

import { activateAccount } from "@nuriteo/api-client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "../../components/ui/button.tsx";
import { createBrowserApiClient } from "../../lib/api/browser-client.ts";
import { collaborationError } from "../../lib/api/browser-security.ts";
import { useExclusiveMutation } from "../../lib/use-exclusive-mutation.ts";

export function ActivationForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const mutation = useExclusiveMutation();
  const [error, setError] = useState<string>();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const token = searchParams.get("token");
    const data = new FormData(form);
    if (token === null) {
      setError("This activation link is missing or invalid.");
      return;
    }
    await mutation.run(async () => {
      setError(undefined);
      try {
        await activateAccount(createBrowserApiClient(), {
          token,
          email: String(data.get("email") ?? ""),
          displayName: String(data.get("displayName") ?? ""),
          password: String(data.get("password") ?? "")
        });
        form.reset();
        router.replace("/sign-in?activated=1");
      } catch (cause) {
        setError(collaborationError(cause, "activation-invitation-terminal"));
      }
    });
  }

  return (
    <main id="main-content" className="entry-page" tabIndex={-1}>
      <section className="entry-card" aria-labelledby="activation-title">
        <p className="eyebrow">Invitation</p>
        <h1 id="activation-title">Activate your account</h1>
        <p className="entry-description">Choose your profile and password. You will sign in separately after activation.</p>
        <form className="sign-in-form" onSubmit={handleSubmit} aria-busy={mutation.isPending}>
          <label className="field-group">Email<input name="email" type="email" autoComplete="username" required maxLength={320} disabled={mutation.isPending} /></label>
          <label className="field-group">Display name<input name="displayName" required maxLength={200} disabled={mutation.isPending} /></label>
          <label className="field-group">Password<input name="password" type="password" autoComplete="new-password" required disabled={mutation.isPending} /></label>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <Button type="submit" variant="primary" disabled={mutation.isPending}>{mutation.isPending ? "Activating…" : "Activate account"}</Button>
        </form>
      </section>
    </main>
  );
}
