import { getCurrentUser } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "../../../_components/entry-unavailable.tsx";
import { safeRequestReference } from "../../../../lib/api/presentation-error.ts";
import { createServerApiClient } from "../../../../lib/api/server-client.ts";
import { IntegrationCaConsole } from "../_components/integration-ca-console.tsx";
import { AdminAccessRequired } from "../_components/admin-access-required.tsx";

export const metadata: Metadata = { title: "SMTP trust" };

export default async function SmtpTrustPage() {
  try {
    const current = await getCurrentUser(await createServerApiClient());
    if (!current.data.user.is_instance_admin) {
      return <AdminAccessRequired description="Server authorization is required to manage SMTP certificate trust." />;
    }
    return <main id="main-content" className="workspace-page">
      <header className="workspace-page__intro"><p className="eyebrow">Outbound email</p><h1>SMTP private CA trust</h1><p>Stage a private CA and activate it only after TLS, EHLO, and configured SMTP authentication succeed.</p></header>
      <IntegrationCaConsole type="smtp" integrationId="default" />
    </main>;
  } catch (error) {
    return <EntryUnavailable title="SMTP trust is temporarily unavailable" description="No certificate change was attempted." reference={safeRequestReference(error)} retryHref="/admin/smtp-trust" />;
  }
}
