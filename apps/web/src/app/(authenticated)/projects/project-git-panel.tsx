"use client";

import {
  ApiError,
  commitAndPushGitRemote,
  connectGitProvider,
  disconnectGitProvider,
  getGitRemote,
  importGitRepository,
  listGitConnections,
  listGitProviders,
  pullGitRemote,
  rotateGitCredential
} from "@nuriteo/api-client";
import type { GitConnection, GitProvider, GitRemote, Project } from "@nuriteo/api-client";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { Button } from "../../../components/ui/button.tsx";
import { createBrowserApiClient } from "../../../lib/api/browser-client.ts";
import { readCsrfCredential } from "../../../lib/api/browser-security.ts";
import { useExclusiveMutation } from "../../../lib/use-exclusive-mutation.ts";

export function ProjectGitPanel({ project }: { readonly project: Project }) {
  const mutation = useExclusiveMutation();
  const [providers, setProviders] = useState<readonly GitProvider[]>([]);
  const [connections, setConnections] = useState<readonly GitConnection[]>([]);
  const [remote, setRemote] = useState<GitRemote>();
  const [remoteEtag, setRemoteEtag] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ readonly error: boolean; readonly text: string }>();

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setFeedback(undefined);
      try {
        const client = createBrowserApiClient();
        const [providerResult, connectionResult, remoteResult] = await Promise.all([
          listGitProviders(client, { signal: controller.signal }),
          listGitConnections(client, { signal: controller.signal }),
          getGitRemote(client, project.id, { signal: controller.signal }).catch((error: unknown) => {
            if (error instanceof ApiError && error.status === 404) return undefined;
            throw error;
          })
        ]);
        setProviders(providerResult.data);
        setConnections(connectionResult.data);
        setRemote(remoteResult?.data);
        setRemoteEtag(remoteResult?.etag);
      } catch (error) {
        if (!controller.signal.aborted) {
          setFeedback({ error: true, text: gitFailureMessage(error) });
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [project.id]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const token = takeSecret(form, "token");
    const input = new FormData(form);
    await run(async () => {
      const result = await connectGitProvider(
        createBrowserApiClient(),
        String(input.get("providerId") ?? ""),
        token,
        { csrfToken: readCsrfCredential() }
      );
      setConnections((items) => [...items, result.data]);
      form.reset();
      return "Git credential connected. Its plaintext will not be shown again.";
    });
  }

  async function rotate(event: FormEvent<HTMLFormElement>, connection: GitConnection) {
    event.preventDefault();
    const form = event.currentTarget;
    const token = takeSecret(form, "token");
    await run(async () => {
      const result = await rotateGitCredential(
        createBrowserApiClient(),
        { id: connection.id, etag: connectionEtag(connection) },
        token,
        { csrfToken: readCsrfCredential() }
      );
      setConnections((items) => items.map((item) => item.id === connection.id ? result.data : item));
      form.reset();
      return "Git credential rotated.";
    });
  }

  async function disconnect(connection: GitConnection) {
    await run(async () => {
      await disconnectGitProvider(
        createBrowserApiClient(),
        { id: connection.id, etag: connectionEtag(connection) },
        { csrfToken: readCsrfCredential() }
      );
      setConnections((items) => items.filter((item) => item.id !== connection.id));
      return "Git credential disconnected.";
    });
  }

  async function importRepository(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = new FormData(event.currentTarget);
    await run(async () => {
      const result = await importGitRepository(createBrowserApiClient(), {
        projectId: project.id,
        repositoryUrl: String(input.get("repositoryUrl") ?? ""),
        branch: String(input.get("branch") ?? "")
      }, { csrfToken: readCsrfCredential() });
      setRemote(result.data.remote);
      setRemoteEtag(result.etag);
      return `Imported ${result.data.changedObjects} Git objects into the Project Working Head.`;
    });
  }

  async function pull() {
    if (remoteEtag === undefined) return;
    await run(async () => {
      const result = await pullGitRemote(
        createBrowserApiClient(),
        project.id,
        remoteEtag,
        { csrfToken: readCsrfCredential() }
      );
      setRemote(result.data.remote);
      setRemoteEtag(result.etag);
      return `Pulled ${result.data.changedObjects} changed Git objects.`;
    });
  }

  async function push(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (remoteEtag === undefined) return;
    const form = event.currentTarget;
    const commitMessage = String(new FormData(form).get("commitMessage") ?? "");
    await run(async () => {
      const result = await commitAndPushGitRemote(createBrowserApiClient(), {
        projectId: project.id,
        etag: remoteEtag,
        commitMessage
      }, { csrfToken: readCsrfCredential() });
      setRemote(result.data.remote);
      setRemoteEtag(result.etag);
      form.reset();
      return `Pushed commit ${result.data.headSha.slice(0, 12)}.`;
    });
  }

  async function run(action: () => Promise<string>) {
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        setFeedback({ error: false, text: await action() });
      } catch (error) {
        setFeedback({ error: true, text: gitFailureMessage(error) });
      }
    });
  }

  const connectedProviderIds = new Set(connections.map((connection) => connection.providerId));
  const availableProviders = providers.filter((provider) => !connectedProviderIds.has(provider.id));
  const activeProvider = remote === undefined
    ? undefined
    : providers.find((provider) => provider.id === remote.providerId);

  return (
    <section aria-labelledby="project-git-title">
      <p className="eyebrow">Server-side integration</p>
      <h3 id="project-git-title">Git remote</h3>
      <p>Credentials are sent once to the Core service, never returned by the API, and never saved in browser storage.</p>
      {loading ? <p aria-live="polite">Loading Git connections…</p> : null}
      {feedback ? <p className={feedback.error ? "form-error" : undefined} role={feedback.error ? "alert" : "status"}>{feedback.text}</p> : null}

      {!loading && availableProviders.length > 0 ? (
        <form className="collaboration-form" onSubmit={connect} aria-busy={mutation.isPending}>
          <h4>Connect a credential</h4>
          <label className="field-group">Provider<select name="providerId" required disabled={mutation.isPending}><option value="">Select a provider</option>{availableProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName} · {provider.host}</option>)}</select></label>
          <label className="field-group">Personal access token<input name="token" type="password" autoComplete="off" required maxLength={61_440} disabled={mutation.isPending} /></label>
          <Button type="submit" disabled={mutation.isPending}>Connect Git</Button>
        </form>
      ) : null}

      {connections.length > 0 ? <ul className="record-list" aria-label="Git credentials">{connections.map((connection) => {
        const provider = providers.find((item) => item.id === connection.providerId);
        return <li key={connection.id}><div><strong>{provider?.displayName ?? "Unavailable provider"}</strong><span>Credential version {connection.credentialVersion}</span></div><div className="record-actions"><form onSubmit={(event) => void rotate(event, connection)}><label className="field-group">Replacement token<input aria-label={`Replacement token for ${provider?.displayName ?? "provider"}`} name="token" type="password" autoComplete="off" required maxLength={61_440} disabled={mutation.isPending} /></label><Button type="submit" disabled={mutation.isPending}>Rotate</Button></form><Button type="button" variant="danger" disabled={mutation.isPending || remote?.providerId === connection.providerId} onClick={() => void disconnect(connection)}>Disconnect</Button></div></li>;
      })}</ul> : null}

      {!loading && remote === undefined ? (
        <form className="collaboration-form" onSubmit={importRepository} aria-busy={mutation.isPending}>
          <h4>Import repository</h4>
          <label className="field-group">HTTPS repository URL<input name="repositoryUrl" type="url" inputMode="url" required placeholder="https://git.example.com/team/project.git" disabled={mutation.isPending || connections.length === 0} /></label>
          <label className="field-group">Branch<input name="branch" required defaultValue="main" maxLength={255} disabled={mutation.isPending || connections.length === 0} /></label>
          <Button type="submit" disabled={mutation.isPending || connections.length === 0}>Import into Working Head</Button>
        </form>
      ) : null}

      {remote !== undefined ? <div className="collaboration-form"><h4>{remote.repositoryUrl}</h4><p>{remote.branch} · {remote.remoteHeadSha.slice(0, 12)} · {activeProvider?.displayName ?? "Configured provider"}</p><div className="record-actions"><Button type="button" disabled={mutation.isPending} onClick={() => void pull()}>Pull</Button></div><form onSubmit={push}><label className="field-group">Commit message<input name="commitMessage" required maxLength={10_240} disabled={mutation.isPending || activeProvider?.allowsWrite === false} /></label><Button type="submit" disabled={mutation.isPending || activeProvider?.allowsWrite === false}>Commit &amp; Push</Button></form></div> : null}
    </section>
  );
}

function connectionEtag(connection: GitConnection): string {
  return `"git-connection-v${connection.connectionVersion}"`;
}

function takeSecret(form: HTMLFormElement, name: string): string {
  const field = form.elements.namedItem(name);
  if (!(field instanceof HTMLInputElement)) return "";
  const value = field.value;
  field.value = "";
  return value;
}

function gitFailureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 412) return "The remote changed. Reload Git state before retrying; no force push was attempted.";
    if (error.code === "COMMIT_OUTCOME_UNKNOWN") return "The push result is uncertain. Re-read the remote before retrying.";
    if (error.code === "REAUTHENTICATION_REQUIRED") return "Sign in again to refresh recent authentication, then retry this credential change.";
    if (error.status === 401 || error.status === 403) return "Your session or Project permission does not allow this Git operation.";
    if (error.status === 413) return "The Git transfer exceeded the configured limit.";
  }
  return "The Git operation could not be completed safely. No credential details were exposed.";
}
