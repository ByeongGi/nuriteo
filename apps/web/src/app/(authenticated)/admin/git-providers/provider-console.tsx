"use client";

import { ApiError, activateGitProvider, createGitProvider, deleteGitProvider, disableGitProvider, updateGitProvider } from "@nuriteo/api-client";
import type { GitProviderAdmin, GitProviderKind } from "@nuriteo/api-client";
import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "../../../../components/ui/button.tsx";
import { createBrowserApiClient } from "../../../../lib/api/browser-client.ts";
import { readCsrfCredential } from "../../../../lib/api/browser-security.ts";
import { useExclusiveMutation } from "../../../../lib/use-exclusive-mutation.ts";
import { IntegrationCaConsole } from "../_components/integration-ca-console.tsx";

export function GitProviderConsole({ initialProviders }: { readonly initialProviders: readonly GitProviderAdmin[] }) {
  const [providers, setProviders] = useState(initialProviders);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string }>();
  const mutation = useExclusiveMutation();
  const options = () => ({ csrfToken: readCsrfCredential() });
  const replace = (provider: GitProviderAdmin) => setProviders((items) => items.map((item) => item.id === provider.id ? provider : item));

  async function execute(action: () => Promise<GitProviderAdmin>, success: string) {
    await mutation.run(async () => {
      setFeedback(undefined);
      try { replace(await action()); setFeedback({ error: false, text: success }); }
      catch (error) { setFeedback(failure(error)); }
    });
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await createGitProvider(createBrowserApiClient(), input(data), options());
        setProviders((items) => [...items, result.data]);
        form.reset();
        setFeedback({ error: false, text: "Provider saved disabled. Configure private CA trust if needed, then validate and activate." });
      } catch (error) { setFeedback(failure(error)); }
    });
  }

  async function update(event: FormEvent<HTMLFormElement>, provider: GitProviderAdmin) {
    event.preventDefault();
    const value = input(new FormData(event.currentTarget));
    await execute(async () => (await updateGitProvider(createBrowserApiClient(), provider.id, provider.configVersion, {
      displayName: value.displayName, apiBaseUrl: value.apiBaseUrl, oauthAuthorizationUrl: value.oauthAuthorizationUrl,
      oauthTokenUrl: value.oauthTokenUrl, oauthClientId: value.oauthClientId, allowsRead: value.allowsRead, allowsWrite: value.allowsWrite
    }, options())).data, "Provider updated. Validate it before use.");
  }

  async function remove(provider: GitProviderAdmin) {
    if (!window.confirm(`Permanently delete ${provider.displayName}?`)) return;
    await mutation.run(async () => {
      try { await deleteGitProvider(createBrowserApiClient(), provider.id, provider.configVersion, options()); setProviders((items) => items.filter((item) => item.id !== provider.id)); }
      catch (error) { setFeedback(failure(error)); }
    });
  }

  return <main id="main-content" className="workspace-page">
    <header className="workspace-page__intro"><p className="eyebrow">Instance Git transport</p><h1>Git providers</h1><p>Register exact HTTPS origins. User credentials remain separate and are never displayed here.</p></header>
    <section aria-labelledby="add-git-provider"><h2 id="add-git-provider">Add Git provider</h2><ProviderForm onSubmit={create} disabled={mutation.isPending} /></section>
    <section id="git-provider-ca" aria-labelledby="git-provider-ca-title"><h2 id="git-provider-ca-title">Private certificate authorities</h2><p>Private CA trust is managed per provider before activation. Certificate contents are accepted once and never displayed again.</p></section>
    <section aria-labelledby="git-provider-list"><h2 id="git-provider-list">Configured providers</h2>{providers.length === 0 ? <p>No Git provider is configured.</p> : <ul className="record-list">{providers.map((provider) => <li key={provider.id}><div><strong>{provider.displayName}</strong><span>{provider.state}</span><small>{provider.kind} · {provider.host}:{provider.port} · configuration v{provider.configVersion}</small></div>{provider.state === "disabled" ? <ProviderForm provider={provider} onSubmit={(event) => void update(event, provider)} disabled={mutation.isPending} /> : null}<IntegrationCaConsole type="git_provider" integrationId={provider.id} /><div className="record-actions">{provider.state === "active" ? <Button onClick={() => void execute(async () => (await disableGitProvider(createBrowserApiClient(), provider.id, provider.configVersion, options())).data, "Provider disabled immediately.")} disabled={mutation.isPending}>Disable</Button> : <Button variant="primary" onClick={() => void execute(async () => (await activateGitProvider(createBrowserApiClient(), provider.id, provider.configVersion, options())).data, "Provider validated and activated.")} disabled={mutation.isPending}>Validate and activate</Button>}<Button variant="danger" onClick={() => void remove(provider)} disabled={mutation.isPending || provider.state !== "disabled"}>Delete</Button></div></li>)}</ul>}</section>
    {feedback ? <p role={feedback.error ? "alert" : "status"}>{feedback.text}</p> : null}
  </main>;
}

function ProviderForm({ provider, onSubmit, disabled }: { readonly provider?: GitProviderAdmin; readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void; readonly disabled: boolean }) {
  return <form className="collaboration-form" onSubmit={onSubmit}><label className="field-group">Display name<input name="displayName" defaultValue={provider?.displayName} required maxLength={200} disabled={disabled} /></label>{provider ? null : <><label className="field-group">Kind<select name="kind" defaultValue="generic"><option value="generic">Generic HTTPS</option><option value="github">GitHub</option><option value="github_enterprise">GitHub Enterprise</option><option value="gitlab">GitLab</option><option value="gitlab_self_managed">GitLab self-managed</option></select></label><label className="field-group">Exact host<input name="host" required maxLength={253} /></label><label className="field-group">Port<input name="port" type="number" min="1" max="65535" defaultValue="443" required /></label></>}<label className="field-group">API base URL<input name="apiBaseUrl" type="url" defaultValue={provider?.apiBaseUrl} required maxLength={2048} /></label><label className="field-group">OAuth authorization URL<input name="oauthAuthorizationUrl" type="url" defaultValue={provider?.oauthAuthorizationUrl ?? ""} maxLength={2048} /></label><label className="field-group">OAuth token URL<input name="oauthTokenUrl" type="url" defaultValue={provider?.oauthTokenUrl ?? ""} maxLength={2048} /></label><label className="field-group">OAuth client ID<input name="oauthClientId" defaultValue={provider?.oauthClientId ?? ""} maxLength={1024} /></label><label><input name="allowsRead" type="checkbox" defaultChecked={provider?.allowsRead ?? true} /> Allow read</label><label><input name="allowsWrite" type="checkbox" defaultChecked={provider?.allowsWrite ?? false} /> Allow write</label><Button type="submit" disabled={disabled}>{provider ? "Update provider" : "Save disabled provider"}</Button></form>;
}

function input(data: FormData) {
  const nullable = (name: string) => String(data.get(name) ?? "").trim() || null;
  return { displayName: String(data.get("displayName") ?? ""), kind: String(data.get("kind") ?? "generic") as GitProviderKind, host: String(data.get("host") ?? ""), port: Number(data.get("port") ?? 443), apiBaseUrl: String(data.get("apiBaseUrl") ?? ""), oauthAuthorizationUrl: nullable("oauthAuthorizationUrl"), oauthTokenUrl: nullable("oauthTokenUrl"), oauthClientId: nullable("oauthClientId"), allowsRead: data.has("allowsRead"), allowsWrite: data.has("allowsWrite") };
}

function failure(error: unknown) {
  if (error instanceof ApiError && error.status === 412) return { error: true, text: "This provider changed elsewhere. Reload before retrying." };
  if (error instanceof ApiError && error.status === 403) return { error: true, text: "Administrator access and recent reauthentication are required." };
  if (error instanceof ApiError && error.status === 409) return { error: true, text: "Disable the provider before editing or deleting it." };
  return { error: true, text: "The Git provider change could not be completed safely." };
}
