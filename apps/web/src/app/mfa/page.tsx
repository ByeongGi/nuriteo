import { getCurrentUser, getMfaStatus } from "@nuriteo/api-client";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { EntryUnavailable } from "../_components/entry-unavailable.tsx";
import { safeRequestReference } from "../../lib/api/presentation-error.ts";
import { createServerApiClient } from "../../lib/api/server-client.ts";
import { MfaSecurity } from "./security.tsx";

export const metadata: Metadata = { title: "Multi-factor authentication" };

export default async function MfaPage() {
  try {
    const client = await createServerApiClient();
    const [current, status] = await Promise.all([
      getCurrentUser(client),
      getMfaStatus(client)
    ]);
    return <MfaSecurity status={status.data} displayName={current.data.user.display_name} />;
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 401) redirect("/sign-in");
    return (
      <EntryUnavailable
        title="Security settings are temporarily unavailable"
        description="Your MFA state could not be loaded safely. No credential was changed."
        reference={safeRequestReference(error)}
        retryHref="/mfa"
      />
    );
  }
}

