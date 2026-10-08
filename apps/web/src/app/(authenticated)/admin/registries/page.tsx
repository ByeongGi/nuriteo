import { listRegistries } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "../../../_components/entry-unavailable.tsx";
import { createServerApiClient } from "../../../../lib/api/server-client.ts";
import { safeRequestReference } from "../../../../lib/api/presentation-error.ts";
import { RegistryConsole } from "./registry-console.tsx";

export const metadata: Metadata = { title: "Package registries" };

export default async function RegistriesPage() {
  try {
    const configuration = await listRegistries(await createServerApiClient());
    return <RegistryConsole initialConfiguration={configuration.data} />;
  } catch (error) {
    return <EntryUnavailable
      title="Package registries are temporarily unavailable"
      description="No registry route or credential was changed."
      reference={safeRequestReference(error)}
      retryHref="/admin/registries"
    />;
  }
}
