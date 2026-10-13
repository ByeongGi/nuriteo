import {
  getAdminStatus,
  getCurrentUser,
  listAdminSettings,
  previewAdminPolicyCleanup
} from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "../../../_components/entry-unavailable.tsx";
import { safeRequestReference } from "../../../../lib/api/presentation-error.ts";
import { createServerApiClient } from "../../../../lib/api/server-client.ts";
import { AdminSettings } from "./admin-settings.tsx";

export const metadata: Metadata = { title: "Administration settings" };

export default async function AdminSettingsPage() {
  try {
    const client = await createServerApiClient();
    const current = await getCurrentUser(client);
    if (!current.data.user.is_instance_admin) {
      return (
        <main id="main-content" className="workspace-page">
          <h1>Administrator access required</h1>
          <p>Server authorization is required to view or change instance settings.</p>
        </main>
      );
    }

    const [settings, status, cleanup] = await Promise.all([
      listAdminSettings(client),
      getAdminStatus(client),
      previewAdminPolicyCleanup(client)
    ]);
    const reconciliationKey = settings.data.items
      .map((setting) => `${setting.key}:${setting.version}`)
      .join("|");
    return (
      <AdminSettings
        key={reconciliationKey}
        cleanup={cleanup.data}
        settings={settings.data}
        status={status.data}
      />
    );
  } catch (error) {
    return (
      <EntryUnavailable
        title="Administration is temporarily unavailable"
        description="Instance settings could not be loaded safely. No setting was changed."
        reference={safeRequestReference(error)}
        retryHref="/admin/settings"
      />
    );
  }
}
