"use client";

import {
  ApiError,
  activateOidcProvider,
  createOidcProvider,
  deleteOidcProvider,
  disableOidcProvider,
  rotateOidcProviderSecret,
  updateOidcProvider
} from "@nuriteo/api-client";
import type { OidcProvider } from "@nuriteo/api-client";
import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "../../../../components/ui/button.tsx";
import { createBrowserApiClient } from "../../../../lib/api/browser-client.ts";
import { readCsrfCredential } from "../../../../lib/api/browser-security.ts";
import { useExclusiveMutation } from "../../../../lib/use-exclusive-mutation.ts";
import { IntegrationCaConsole } from "../_components/integration-ca-console.tsx";

export function OidcProviderConsole({ initialProviders }: { readonly initialProviders: readonly OidcProvider[] }) {
  const mutation = useExclusiveMutation();
  const [providers, setProviders] = useState(initialProviders);
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();
  const options = () => ({ csrfToken: readCsrfCredential() });
  const replace = (provider: OidcProvider) => setProviders((items) => items.map((item) => item.id === provider.id ? provider : item));

  async function run(action: () => Promise<OidcProvider>, success: string) {
    await mutation.run(async () => {
      setFeedback(undefined);
      try { replace(await action()); setFeedback({ error: false, text: success }); }
      catch (error) { setFeedback(providerFailure(error)); }
    });
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await createOidcProvider(createBrowserApiClient(), {
          displayName: String(data.get("displayName") ?? ""), issuer: String(data.get("issuer") ?? ""),
          clientId: String(data.get("clientId") ?? ""), clientSecret: String(data.get("clientSecret") ?? "")
        }, options());
        setProviders((items) => [...items, result.data]); form.reset();
        setFeedback({ error: false, text: "Provider saved in disabled state. Validate and activate it before users can sign in." });
      } catch (error) { setFeedback(providerFailure(error)); }
    });
  }

  async function update(event: FormEvent<HTMLFormElement>, provider: OidcProvider) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    await run(async () => (await updateOidcProvider(createBrowserApiClient(), provider.id, provider.configVersion, { displayName: String(data.get("displayName") ?? ""), clientId: String(data.get("clientId") ?? "") }, options())).data, "Provider metadata updated. It remains disabled until validation succeeds.");
  }

  async function rotate(event: FormEvent<HTMLFormElement>, provider: OidcProvider) {
    event.preventDefault();
    const form = event.currentTarget;
    const secret = String(new FormData(form).get("clientSecret") ?? "");
    await run(async () => (await rotateOidcProviderSecret(createBrowserApiClient(), provider.id, provider.configVersion, secret, options())).data, "Secret rotated; validate and activate the Provider again.");
    form.reset();
  }

  async function remove(provider: OidcProvider) {
    if (!window.confirm(`Permanently delete ${provider.displayName}?`)) return;
    await mutation.run(async () => {
      setFeedback(undefined);
      try { await deleteOidcProvider(createBrowserApiClient(), provider.id, provider.configVersion, options()); setProviders((items) => items.filter((item) => item.id !== provider.id)); setFeedback({ error: false, text: "Provider deleted." }); }
      catch (error) { setFeedback(providerFailure(error)); }
    });
  }

  return <main id="main-content" className="workspace-page">
    <header className="workspace-page__intro"><p className="eyebrow">Instance authentication</p><h1>Identity providers</h1><p>Configure multiple global OIDC Providers. New and edited Providers stay disabled until live discovery, TLS, issuer, endpoint, and credential validation succeeds.</p></header>
    <section aria-labelledby="add-provider"><h2 id="add-provider">Add Provider</h2><form className="collaboration-form" onSubmit={create} aria-busy={mutation.isPending}>
      <label className="field-group">Display name<input name="displayName" maxLength={200} required disabled={mutation.isPending} /></label>
      <label className="field-group">Issuer URL<input name="issuer" type="url" maxLength={2048} required disabled={mutation.isPending} /></label>
      <label className="field-group">Client ID<input name="clientId" maxLength={1024} required disabled={mutation.isPending} /></label>
      <label className="field-group">Client secret<input name="clientSecret" type="password" autoComplete="new-password" maxLength={4096} required disabled={mutation.isPending} /></label>
      <Button type="submit" variant="primary" disabled={mutation.isPending}>Save disabled Provider</Button>
    </form></section>
    <section aria-labelledby="provider-list"><h2 id="provider-list">Configured Providers</h2>{providers.length === 0 ? <p>No OIDC Provider is configured.</p> : <ul className="record-list">{providers.map((provider) => <li key={provider.id}><div><strong>{provider.displayName}</strong><span>{provider.state} · {provider.linkedIdentityCount} connected identities</span><small>{provider.issuer} · configuration v{provider.configVersion} · secret v{provider.secretVersion}</small></div>
      <form className="collaboration-form" onSubmit={(event) => void update(event, provider)}><label className="field-group">Display name<input name="displayName" defaultValue={provider.displayName} required disabled={mutation.isPending || provider.state === "active"} /></label><label className="field-group">Client ID<input name="clientId" defaultValue={provider.clientId} required disabled={mutation.isPending || provider.state === "active"} /></label><Button disabled={mutation.isPending || provider.state === "active"}>Update metadata</Button></form>
      {provider.state === "disabled" ? <form className="collaboration-form" onSubmit={(event) => void rotate(event, provider)}><label className="field-group">Replacement client secret<input name="clientSecret" type="password" autoComplete="new-password" maxLength={4096} required disabled={mutation.isPending} /></label><Button disabled={mutation.isPending}>Rotate secret</Button></form> : null}
      <IntegrationCaConsole type="oidc" integrationId={provider.id} />
      <div className="record-actions">{provider.state === "active" ? <Button disabled={mutation.isPending} onClick={() => void run(async () => (await disableOidcProvider(createBrowserApiClient(), provider.id, provider.configVersion, options())).data, "Provider disabled immediately.")}>Disable</Button> : <Button variant="primary" disabled={mutation.isPending} onClick={() => void run(async () => (await activateOidcProvider(createBrowserApiClient(), provider.id, provider.configVersion, `${window.location.origin}/api/v1/auth/oidc/${provider.id}/callback`, options())).data, "Provider validated and activated.")}>Validate and activate</Button>}
      <Button variant="danger" disabled={mutation.isPending || provider.state !== "disabled" || provider.linkedIdentityCount !== 0} onClick={() => void remove(provider)}>Delete</Button></div></li>)}</ul>}</section>
    {feedback ? <p className={`notification-feedback notification-feedback--${feedback.error ? "error" : "success"}`} role={feedback.error ? "alert" : "status"}>{feedback.text}</p> : null}
  </main>;
}

function providerFailure(error: unknown): { readonly error: true; readonly text: string } {
  if (error instanceof ApiError && error.code === "COMMIT_OUTCOME_UNKNOWN") return { error: true, text: "The change may have completed. Reload before retrying." };
  if (error instanceof ApiError && error.status === 412) return { error: true, text: "This Provider changed elsewhere. Reload before retrying." };
  if (error instanceof ApiError && error.status === 403) return { error: true, text: "Administrator access and recent reauthentication are required." };
  if (error instanceof ApiError && (error.status === 400 || error.status === 422)) return { error: true, text: "Validation failed. Check the HTTPS issuer, client settings, redirect URI, and Provider network reachability." };
  if (error instanceof ApiError && error.status === 409) return { error: true, text: "Disable the Provider first and remove connected identities before deletion." };
  return { error: true, text: "The Provider change could not be completed safely." };
}
