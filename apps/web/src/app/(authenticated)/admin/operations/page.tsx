import { getAdminOperations, getCurrentUser } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "../../../_components/entry-unavailable.tsx";
import { safeRequestReference } from "../../../../lib/api/presentation-error.ts";
import { createServerApiClient } from "../../../../lib/api/server-client.ts";
import { AdminAccessRequired } from "../_components/admin-access-required.tsx";
import { OperationsDashboard } from "./operations-dashboard.tsx";

export const metadata: Metadata = { title: "Instance operations" };

export default async function AdminOperationsPage() {
  try {
    const client = await createServerApiClient();
    const current = await getCurrentUser(client);
    if (!current.data.user.is_instance_admin) {
      return <AdminAccessRequired description="Server authorization is required to view instance operations." />;
    }
    const operations = await getAdminOperations(client);
    return <OperationsDashboard operations={operations.data} />;
  } catch (error) {
    return (
      <EntryUnavailable
        title="Operations are temporarily unavailable"
        description="The instance summary could not be loaded safely. No diagnostic details were exposed."
        reference={safeRequestReference(error)}
        retryHref="/admin/operations"
      />
    );
  }
}
