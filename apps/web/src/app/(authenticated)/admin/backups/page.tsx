import { getAdminBackups, getCurrentUser } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "../../../_components/entry-unavailable.tsx";
import { safeRequestReference } from "../../../../lib/api/presentation-error.ts";
import { createServerApiClient } from "../../../../lib/api/server-client.ts";
import { BackupConsole } from "./backup-console.tsx";

export const metadata: Metadata = { title: "Backups" };

export default async function AdminBackupsPage() {
  try {
    const client = await createServerApiClient();
    const [current, backups] = await Promise.all([
      getCurrentUser(client),
      getAdminBackups(client)
    ]);
    if (!current.data.user.is_instance_admin) {
      return (
        <main id="main-content" className="workspace-page">
          <h1>Administrator access required</h1>
          <p>Server authorization is required to manage instance backups.</p>
        </main>
      );
    }
    return <BackupConsole initial={backups.data} />;
  } catch (error) {
    return (
      <EntryUnavailable
        title="Backup controls are temporarily unavailable"
        description="The restore-point and policy state could not be verified safely. No backup change was made."
        reference={safeRequestReference(error)}
        retryHref="/admin/backups"
      />
    );
  }
}
