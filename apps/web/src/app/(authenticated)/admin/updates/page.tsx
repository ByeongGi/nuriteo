import { getCurrentUser } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "../../../_components/entry-unavailable.tsx";
import { safeRequestReference } from "../../../../lib/api/presentation-error.ts";
import { createServerApiClient } from "../../../../lib/api/server-client.ts";
import { UpdateReadinessConsole } from "./update-readiness-console.tsx";
import { getAdminUpdateHistory, getAdminUpdateReadiness } from "./update-model.ts";

export const metadata: Metadata = { title: "Update readiness" };

export default async function AdminUpdatesPage() {
  try {
    const client = await createServerApiClient();
    const current = await getCurrentUser(client);
    if (!current.data.user.is_instance_admin) {
      return (
        <main id="main-content" className="workspace-page">
          <h1>Administrator access required</h1>
          <p>Server authorization is required to review or approve instance updates.</p>
        </main>
      );
    }
    const [readiness, history] = await Promise.all([
      getAdminUpdateReadiness(client),
      getAdminUpdateHistory(client)
    ]);
    return <UpdateReadinessConsole readiness={readiness} history={history} />;
  } catch (error) {
    return (
      <EntryUnavailable
        title="Update readiness is temporarily unavailable"
        description="Compatibility and preflight status could not be loaded safely. No update was approved or started."
        reference={safeRequestReference(error)}
        retryHref="/admin/updates"
      />
    );
  }
}
