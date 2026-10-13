import { getCurrentUser, listActivationInvitations } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "../../../_components/entry-unavailable.tsx";
import { createServerApiClient } from "../../../../lib/api/server-client.ts";
import { safeRequestReference } from "../../../../lib/api/presentation-error.ts";
import { ActivationInvitations } from "./activation-invitations.tsx";

export const metadata: Metadata = { title: "Activation invitations" };

export default async function ActivationInvitationsPage() {
  try {
    const client = await createServerApiClient();
    const current = await getCurrentUser(client);
    if (!current.data.user.is_instance_admin) {
      return <main id="main-content" className="workspace-page"><h1>Administrator access required</h1><p>Server authorization is required for invitation management.</p></main>;
    }
    const invitations = await listActivationInvitations(client);
    return <ActivationInvitations invitations={invitations.data.items} />;
  } catch (error) {
    return <EntryUnavailable title="Invitations are temporarily unavailable" description="The invitation list could not be loaded safely." reference={safeRequestReference(error)} retryHref="/admin/invitations" />;
  }
}
