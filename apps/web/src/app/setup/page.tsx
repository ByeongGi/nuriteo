import { getSetupStatus } from "@nuriteo/api-client";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { EntryUnavailable } from "../_components/entry-unavailable.tsx";
import { createServerApiClient } from "../../lib/api/server-client.ts";
import { safeRequestReference } from "../../lib/api/presentation-error.ts";

export const metadata: Metadata = {
  title: "Set up this instance"
};

const COMPOSE_BOOTSTRAP_COMMAND = "docker compose run --rm bootstrap-admin";

export default async function SetupPage() {
  let bootstrapRequired: boolean;

  try {
    const client = await createServerApiClient();
    const result = await getSetupStatus(client);
    bootstrapRequired = result.data.bootstrapRequired;
  } catch (error) {
    return (
      <EntryUnavailable
        description="NURITEO could not check the bootstrap state. Retry after confirming that the Core service is healthy."
        reference={safeRequestReference(error)}
        retryHref="/setup"
        title="Setup status is unavailable"
      />
    );
  }

  if (!bootstrapRequired) {
    redirect("/sign-in");
  }

  return (
    <main id="main-content" className="entry-page" tabIndex={-1}>
      <section className="entry-card" aria-labelledby="setup-title">
        <p className="eyebrow">Administrator setup</p>
        <h1 id="setup-title">Finish setup from your server</h1>
        <p className="entry-description">
          For security, the first administrator can only be created with the NURITEO command-line
          tool. This page never accepts or displays the bootstrap password.
        </p>

        <div className="command-panel" aria-labelledby="compose-command-title">
          <h2 id="compose-command-title">Docker Compose</h2>
          <p>Configure the bootstrap secret files on the host, then run:</p>
          <code>{COMPOSE_BOOTSTRAP_COMMAND}</code>
        </div>

        <div className="entry-actions">
          <Link className="link-button" href="/">
            Check setup status
          </Link>
          <p>The check is made directly against Core and is never cached.</p>
        </div>
      </section>
    </main>
  );
}
