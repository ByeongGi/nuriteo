import { getSetupStatus } from "@nuriteo/api-client";
import { redirect } from "next/navigation";

import { EntryUnavailable } from "./_components/entry-unavailable.tsx";
import { createServerApiClient } from "../lib/api/server-client.ts";
import { safeRequestReference } from "../lib/api/presentation-error.ts";
import { setupDestination } from "../lib/setup-destination.ts";

export default async function HomePage() {
  let bootstrapRequired: boolean;

  try {
    const client = await createServerApiClient();
    const result = await getSetupStatus(client);
    bootstrapRequired = result.data.bootstrapRequired;
  } catch (error) {
    return (
      <EntryUnavailable
        description="NURITEO could not confirm whether this installation is ready. No setup action has been assumed."
        reference={safeRequestReference(error)}
        retryHref="/"
        title="Setup status is unavailable"
      />
    );
  }

  redirect(setupDestination(bootstrapRequired));
}
