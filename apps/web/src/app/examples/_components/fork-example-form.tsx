"use client";

import {
  ApiError,
  forkPublishedExample,
  getCurrentWorkspaces
} from "@nuriteo/api-client";
import type { PublicPublishedExample, Workspace } from "@nuriteo/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { Button } from "../../../components/ui/button.tsx";
import { readCsrfCredential } from "../../../lib/api/browser-security.ts";
import { createBrowserApiClient } from "../../../lib/api/browser-client.ts";

interface Props {
  readonly example: PublicPublishedExample;
}

interface Attempt {
  readonly key: string;
  readonly signature: string;
}

export function ForkExampleForm({ example }: Props) {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<readonly Workspace[]>();
  const [selectedScope, setSelectedScope] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "signed-out" | "unavailable">("loading");
  const [error, setError] = useState<string>();
  const [forkSessionEnded, setForkSessionEnded] = useState(false);
  const [pending, setPending] = useState(false);
  const attempt = useRef<Attempt | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    void getCurrentWorkspaces(createBrowserApiClient(), { signal: controller.signal })
      .then((result) => {
        setWorkspaces(result.data.workspaces);
        setSelectedScope(result.data.workspaces[0]?.storageScopeId ?? "");
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setStatus(cause instanceof ApiError && cause.status === 401 ? "signed-out" : "unavailable");
      });
    return () => controller.abort();
  }, []);

  async function fork(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const workspace = workspaces?.find((item) => item.storageScopeId === selectedScope);
    if (workspace === undefined || pending) return;
    const data = new FormData(event.currentTarget);
    const slug = String(data.get("slug") ?? "");
    const name = String(data.get("name") ?? "");
    const signature = JSON.stringify([example.publicId, example.versionNumber, selectedScope, slug, name]);
    if (attempt.current?.signature !== signature) {
      attempt.current = { key: `published-example-fork-${crypto.randomUUID()}`, signature };
    }
    setPending(true);
    setError(undefined);
    setForkSessionEnded(false);
    try {
      const result = await forkPublishedExample(createBrowserApiClient(), {
        publicId: example.publicId,
        versionNumber: example.versionNumber,
        destinationOwner: {
          ownerType: workspace.ownerType,
          ownerId: workspace.ownerId
        },
        slug,
        name,
        idempotencyKey: attempt.current.key
      }, { csrfToken: readCsrfCredential() });
      router.push(
        `/projects?workspace=${encodeURIComponent(workspace.storageScopeId)}&project=${encodeURIComponent(result.data.project.id)}`
      );
    } catch (cause) {
      setForkSessionEnded(cause instanceof ApiError && cause.status === 401);
      setError(forkError(cause));
    } finally {
      setPending(false);
    }
  }

  if (status === "loading") {
    return <p aria-live="polite" className="text-sm text-muted-foreground">Checking available Workspaces…</p>;
  }
  if (status === "signed-out") {
    return (
      <div className="rounded-lg border border-muted-border bg-subtle p-4 text-left">
        <p className="m-0 text-sm text-muted-foreground">Sign in to fork this fixed version into your own Workspace.</p>
        <Link className="mt-3 inline-flex text-sm font-semibold text-link underline-offset-4 hover:underline" href="/sign-in">
          Sign in to fork
        </Link>
      </div>
    );
  }
  if (status === "unavailable") {
    return <p role="alert" className="text-sm text-danger">Workspace information is temporarily unavailable.</p>;
  }
  if (workspaces?.length === 0) {
    return <p className="text-sm text-muted-foreground">No writable Workspace is available for this account.</p>;
  }

  return (
    <form className="grid gap-4 rounded-lg border border-muted-border bg-subtle p-4 text-left" onSubmit={fork} aria-busy={pending}>
      <div>
        <h3 className="m-0 text-base font-semibold text-foreground">Fork this version</h3>
        <p className="mt-1 text-sm text-muted-foreground">Creates an independent Project without source access, Git connections, or environment values.</p>
      </div>
      <label className="grid gap-1.5 text-sm font-medium text-foreground">
        Workspace
        <select
          className="min-h-10 rounded-md border border-border bg-surface px-3 text-foreground"
          disabled={pending}
          onChange={(event) => setSelectedScope(event.currentTarget.value)}
          required
          value={selectedScope}
        >
          {workspaces?.map((workspace) => (
            <option key={workspace.storageScopeId} value={workspace.storageScopeId}>
              {workspace.displayLabel}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1.5 text-sm font-medium text-foreground">
        Project slug
        <input
          className="min-h-10 rounded-md border border-border bg-surface px-3 text-foreground"
          defaultValue={suggestedSlug(example.name)}
          disabled={pending}
          maxLength={63}
          name="slug"
          pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
          required
        />
      </label>
      <label className="grid gap-1.5 text-sm font-medium text-foreground">
        Project name
        <input
          className="min-h-10 rounded-md border border-border bg-surface px-3 text-foreground"
          defaultValue={`${example.name} fork`}
          disabled={pending}
          maxLength={200}
          name="name"
          required
        />
      </label>
      {error === undefined ? null : (
        <div className="grid gap-2 text-sm text-danger" role="alert">
          <p className="m-0">{error}</p>
          {forkSessionEnded ? (
            <Link className="w-fit font-semibold text-link underline-offset-4 hover:underline" href="/sign-in">
              Sign in to continue
            </Link>
          ) : null}
        </div>
      )}
      <Button disabled={pending || selectedScope === ""} type="submit" variant="primary">
        {pending ? "Forking…" : "Fork into Workspace"}
      </Button>
    </form>
  );
}

function suggestedSlug(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 58)
    .replace(/-+$/gu, "");
  return normalized === "" ? "example-fork" : `${normalized}-fork`;
}

function forkError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "COMMIT_OUTCOME_UNKNOWN") {
      return "The fork may have completed. Retry with the same values to reconcile it safely.";
    }
    if (error.status === 401) return "Your session ended. Sign in again before forking.";
    if (error.status === 403) return "You cannot create a Project in that Workspace.";
    if (error.status === 404) return "This published version is no longer available.";
    if (error.status === 409) return "That Project slug is already in use, or the Workspace quota was reached.";
    if (error.status === 400 || error.status === 422) return "Review the Project slug and name, then try again.";
  }
  return "The fork could not be completed. Your source example was not changed.";
}
