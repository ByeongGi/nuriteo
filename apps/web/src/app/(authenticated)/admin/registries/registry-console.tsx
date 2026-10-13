"use client";

import {
  ApiError,
  activateRegistry,
  createRegistry,
  deleteRegistry,
  disableRegistry,
  mapRegistryScope,
  renameRegistry,
  rotateRegistryToken,
  setDefaultRegistry
} from "@nuriteo/api-client";
import type {
  RegistryConfiguration,
  RegistryConnection,
  RegistryScopeRoute
} from "@nuriteo/api-client";
import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "../../../../components/ui/button.tsx";
import { createBrowserApiClient } from "../../../../lib/api/browser-client.ts";
import { readCsrfCredential } from "../../../../lib/api/browser-security.ts";
import { useExclusiveMutation } from "../../../../lib/use-exclusive-mutation.ts";
import { IntegrationCaConsole } from "../_components/integration-ca-console.tsx";

export function RegistryConsole({
  initialConfiguration
}: {
  readonly initialConfiguration: RegistryConfiguration;
}) {
  const mutation = useExclusiveMutation();
  const [registries, setRegistries] = useState(initialConfiguration.items);
  const [scopes, setScopes] = useState(initialConfiguration.scopes);
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();
  const options = () => ({ csrfToken: readCsrfCredential() });
  const replace = (registry: RegistryConnection) => {
    setRegistries((items) => items.map((item) => {
      if (item.id === registry.id) return registry;
      return registry.isDefault && item.isDefault ? { ...item, isDefault: false } : item;
    }));
  };

  async function run(action: () => Promise<RegistryConnection>, success: string) {
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        replace(await action());
        setFeedback({ error: false, text: success });
      } catch (error) {
        setFeedback(registryFailure(error));
      }
    });
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        const result = await createRegistry(createBrowserApiClient(), {
          displayName: String(data.get("displayName") ?? ""),
          baseUrl: String(data.get("baseUrl") ?? ""),
          token: String(data.get("token") ?? "")
        }, options());
        setRegistries((items) => [...items, result.data]);
        form.reset();
        setFeedback({
          error: false,
          text: "Registry saved disabled. Its token cannot be displayed again; validate it before routing packages."
        });
      } catch (error) {
        setFeedback(registryFailure(error));
      }
    });
  }

  async function rename(event: FormEvent<HTMLFormElement>, registry: RegistryConnection) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("displayName") ?? "");
    await run(
      async () => (await renameRegistry(createBrowserApiClient(), registry.id, registry.configVersion, name, options())).data,
      "Registry name updated."
    );
  }

  async function rotate(event: FormEvent<HTMLFormElement>, registry: RegistryConnection) {
    event.preventDefault();
    const form = event.currentTarget;
    const token = String(new FormData(form).get("token") ?? "");
    await run(
      async () => (await rotateRegistryToken(createBrowserApiClient(), registry.id, registry.configVersion, token, options())).data,
      "Token rotated and discarded from the browser. Validate the Registry again."
    );
    form.reset();
  }

  async function mapScope(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const scope = String(data.get("scope") ?? "");
    const connectionId = String(data.get("connectionId") ?? "");
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        await mapRegistryScope(createBrowserApiClient(), scope, connectionId, options());
        setScopes((items) => replaceScope(items, { scope, connectionId }));
        setFeedback({ error: false, text: `${scope} now routes only to the selected Registry.` });
      } catch (error) {
        setFeedback(registryFailure(error));
      }
    });
  }

  async function remove(registry: RegistryConnection) {
    if (!window.confirm(`Permanently delete ${registry.displayName}?`)) return;
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        await deleteRegistry(createBrowserApiClient(), registry.id, registry.configVersion, options());
        setRegistries((items) => items.filter((item) => item.id !== registry.id));
        setScopes((items) => items.filter((item) => item.connectionId !== registry.id));
        setFeedback({ error: false, text: "Registry and its stored credential were deleted." });
      } catch (error) {
        setFeedback(registryFailure(error));
      }
    });
  }

  const active = registries.filter((registry) => registry.state === "active");
  return <main id="main-content" className="workspace-page">
    <header className="workspace-page__intro">
      <p className="eyebrow">Instance package routing</p>
      <h1>Package registries</h1>
      <p>Configure global npm-compatible registries. Scope routes are exact and never fall back to another Registry when the selected route fails.</p>
    </header>
    <section aria-labelledby="add-registry">
      <h2 id="add-registry">Add Registry</h2>
      <form className="collaboration-form" onSubmit={create} aria-busy={mutation.isPending}>
        <label className="field-group">Display name<input name="displayName" maxLength={200} required disabled={mutation.isPending} /></label>
        <label className="field-group">HTTPS base URL<input name="baseUrl" type="url" maxLength={2048} required disabled={mutation.isPending} /></label>
        <label className="field-group">Access token<input name="token" type="password" autoComplete="new-password" maxLength={4096} required disabled={mutation.isPending} /></label>
        <Button type="submit" variant="primary" disabled={mutation.isPending}>Save disabled Registry</Button>
      </form>
    </section>
    <section aria-labelledby="registry-list">
      <h2 id="registry-list">Configured Registries</h2>
      {registries.length === 0 ? <p>No Registry is configured.</p> : <ul className="record-list">{registries.map((registry) => <li key={registry.id}>
        <div><strong>{registry.displayName}{registry.isDefault ? " · default" : ""}</strong><span>{registry.state}</span><small>{registry.baseUrl} · configuration v{registry.configVersion} · credential v{registry.credentialVersion}</small></div>
        {registry.state === "disabled" ? <>
          <form className="collaboration-form" onSubmit={(event) => void rename(event, registry)}><label className="field-group">Display name<input name="displayName" defaultValue={registry.displayName} maxLength={200} required disabled={mutation.isPending} /></label><Button disabled={mutation.isPending}>Rename</Button></form>
          <form className="collaboration-form" onSubmit={(event) => void rotate(event, registry)}><label className="field-group">Replacement token<input name="token" type="password" autoComplete="new-password" maxLength={4096} required disabled={mutation.isPending} /></label><Button disabled={mutation.isPending}>Rotate token</Button></form>
        </> : null}
        <IntegrationCaConsole type="registry" integrationId={registry.id} />
        <div className="record-actions">
          {registry.state === "active" ? <Button disabled={mutation.isPending} onClick={() => void run(async () => (await disableRegistry(createBrowserApiClient(), registry.id, registry.configVersion, options())).data, "Registry disabled immediately; its routes will not fall back.")}>Disable</Button> : <Button variant="primary" disabled={mutation.isPending} onClick={() => void run(async () => (await activateRegistry(createBrowserApiClient(), registry.id, registry.configVersion, options())).data, "Registry validated and activated.")}>Validate and activate</Button>}
          <Button disabled={mutation.isPending || registry.state !== "active" || registry.isDefault} onClick={() => void run(async () => (await setDefaultRegistry(createBrowserApiClient(), registry.id, registry.configVersion, options())).data, "Default Registry updated.")}>Make default</Button>
          <Button variant="danger" disabled={mutation.isPending || registry.state !== "disabled"} onClick={() => void remove(registry)}>Delete</Button>
        </div>
      </li>)}</ul>}
    </section>
    <section aria-labelledby="scope-routing">
      <h2 id="scope-routing">Scope routing</h2>
      <p>Map an exact npm scope such as <code>@company</code> to one active Registry. A missing or unavailable mapped Registry fails closed.</p>
      <form className="collaboration-form" onSubmit={mapScope}>
        <label className="field-group">Package scope<input name="scope" placeholder="@company" maxLength={65} required disabled={mutation.isPending || active.length === 0} /></label>
        <label className="field-group">Registry<select name="connectionId" required disabled={mutation.isPending || active.length === 0}>{active.map((registry) => <option key={registry.id} value={registry.id}>{registry.displayName}</option>)}</select></label>
        <Button disabled={mutation.isPending || active.length === 0}>Save scope route</Button>
      </form>
      {scopes.length === 0 ? <p>No scope route is configured.</p> : <ul className="record-list">{scopes.map((route) => <li key={route.scope}><div><strong>{route.scope}</strong><span>{registries.find((registry) => registry.id === route.connectionId)?.displayName ?? "Unavailable Registry"}</span></div></li>)}</ul>}
    </section>
    {feedback ? <p className={`notification-feedback notification-feedback--${feedback.error ? "error" : "success"}`} role={feedback.error ? "alert" : "status"}>{feedback.text}</p> : null}
  </main>;
}

function replaceScope(
  routes: readonly RegistryScopeRoute[],
  replacement: RegistryScopeRoute
): readonly RegistryScopeRoute[] {
  const remaining = routes.filter((route) => route.scope !== replacement.scope);
  return [...remaining, replacement].toSorted((left, right) => left.scope.localeCompare(right.scope));
}

function registryFailure(error: unknown): { readonly error: true; readonly text: string } {
  if (error instanceof ApiError && error.code === "COMMIT_OUTCOME_UNKNOWN") return { error: true, text: "The change may have completed. Reload before retrying." };
  if (error instanceof ApiError && error.status === 412) return { error: true, text: "This Registry changed elsewhere. Reload before retrying." };
  if (error instanceof ApiError && error.status === 403) return { error: true, text: "Administrator access and recent reauthentication are required." };
  if (error instanceof ApiError && (error.status === 400 || error.status === 422)) return { error: true, text: "Validation failed. Check the HTTPS URL, token, TLS trust, and Registry network reachability." };
  if (error instanceof ApiError && error.status === 409) return { error: true, text: "Disable the Registry before editing or deleting it. Active scope routes never fall back." };
  return { error: true, text: "The Registry change could not be completed safely." };
}
