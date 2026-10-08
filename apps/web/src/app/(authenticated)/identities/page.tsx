import { listOidcIdentities } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "../../_components/entry-unavailable.tsx";
import { createServerApiClient } from "../../../lib/api/server-client.ts";
import { safeRequestReference } from "../../../lib/api/presentation-error.ts";
import { IdentityConnections } from "./identity-connections.tsx";

export const metadata: Metadata = { title: "Connected identities" };

export default async function IdentitiesPage() {
  try {
    const identities = await listOidcIdentities(await createServerApiClient());
    return <IdentityConnections initialIdentities={identities.data} />;
  } catch (error) {
    return <EntryUnavailable title="Connected identities are temporarily unavailable" description="No identity connection was changed. Retry when the identity service is available." reference={safeRequestReference(error)} retryHref="/identities" />;
  }
}
