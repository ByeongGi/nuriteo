import { getCurrentUser } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "../../../_components/entry-unavailable.tsx";
import { safeRequestReference } from "../../../../lib/api/presentation-error.ts";
import { createServerApiClient } from "../../../../lib/api/server-client.ts";
import { MaintenanceConsole } from "./maintenance-console.tsx";
import { getAdminMaintenanceStatus } from "./maintenance-model.ts";

export const metadata: Metadata = { title: "Maintenance mode" };

export default async function AdminMaintenancePage() {
  try {
    const client = await createServerApiClient();
    const current = await getCurrentUser(client);
    if (!current.data.user.is_instance_admin) {
      return (
        <main id="main-content" className="workspace-page">
          <h1>Administrator access required</h1>
          <p>Server authorization is required to control instance maintenance.</p>
        </main>
      );
    }
    return <MaintenanceConsole initial={await getAdminMaintenanceStatus(client)} />;
  } catch (error) {
    return (
      <EntryUnavailable
        title="Maintenance controls are temporarily unavailable"
        description="The current write-admission state could not be verified safely. No maintenance change was made."
        reference={safeRequestReference(error)}
        retryHref="/admin/maintenance"
      />
    );
  }
}
