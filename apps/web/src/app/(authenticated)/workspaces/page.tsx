import { getCurrentWorkspaces } from "@nuriteo/api-client";
import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { EntryUnavailable } from "../../_components/entry-unavailable.tsx";
import {
  isExplicitlySignedOut,
  safeRequestReference
} from "../../../lib/api/presentation-error.ts";
import { createServerApiClient } from "../../../lib/api/server-client.ts";
import {
  resolveWorkspaceSelection,
  workspaceOwnerLabel
} from "../../../lib/workspace-selection.ts";

export const metadata: Metadata = {
  title: "Workspaces"
};

interface WorkspacesPageProps {
  readonly searchParams: Promise<{
    invitation?: string | string[] | undefined;
    joined?: string | string[] | undefined;
    workspace?: string | string[] | undefined;
  }>;
}

export default async function WorkspacesPage({ searchParams }: WorkspacesPageProps) {
  const {
    invitation,
    joined,
    workspace: requestedScope
  } = await searchParams;
  const invitationStatus = joined === "1"
    ? "Organization invitation accepted. The shared Workspace is now available."
    : invitation === "declined"
      ? "Organization invitation declined. No Workspace access was added."
      : undefined;
  try {
    const client = await createServerApiClient();
    const result = await getCurrentWorkspaces(client);
    const workspaces = result.data.workspaces;
    const selectedScope = resolveWorkspaceSelection(workspaces, requestedScope);

    if (workspaces.length === 0) {
      return (
        <main id="main-content" className="workspace-page" tabIndex={-1}>
          <section className="workspace-empty" aria-labelledby="workspace-empty-title">
            <p className="eyebrow">No Workspace available</p>
            <h1 id="workspace-empty-title">Ask an administrator for access</h1>
            <p>
              Your account is active, but it does not currently have a Personal or Organization
              Workspace.
            </p>
            <Link className="link-button" href="/workspaces">
              Retry Workspace access
            </Link>
          </section>
        </main>
      );
    }

    return (
      <main id="main-content" className="workspace-page" tabIndex={-1}>
        <header className="workspace-page__intro">
          <p className="eyebrow">Choose your context</p>
          <h1>Workspaces</h1>
          <p>
            Personal work stays with your account. Organization work is shared with its members.
          </p>
        </header>

        {invitationStatus ? (
          <p className="form-status" role="status" aria-live="polite">
            {invitationStatus}
          </p>
        ) : null}

        <nav className="workspace-selector" aria-labelledby="workspace-selector-title">
          <h2 id="workspace-selector-title">Available Workspaces</h2>
          <ul>
            {workspaces.map((workspace) => {
              const isSelected = workspace.storageScopeId === selectedScope;
              const ownerLabel = workspaceOwnerLabel(workspace);
              return (
                <li key={workspace.storageScopeId}>
                  <Link
                    className="workspace-option"
                    href={`/workspaces?workspace=${encodeURIComponent(workspace.storageScopeId)}`}
                    aria-current={isSelected ? "page" : undefined}
                  >
                    <span className="workspace-option__copy">
                      <strong>{workspace.displayLabel}</strong>
                      <span>{ownerLabel} Workspace</span>
                    </span>
                    <span className="workspace-option__state" aria-hidden={!isSelected}>
                      {isSelected ? "Current" : "Select"}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </main>
    );
  } catch (error) {
    if (isExplicitlySignedOut(error)) {
      redirect("/sign-in");
    }

    return (
      <EntryUnavailable
        description="NURITEO could not load your Workspaces. Retry when the Core service is available."
        reference={safeRequestReference(error)}
        retryHref="/workspaces"
        title="Workspaces are temporarily unavailable"
      />
    );
  }
}
