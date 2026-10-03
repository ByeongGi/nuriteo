import { getCurrentUser } from "@nuriteo/api-client";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { EntryUnavailable } from "../_components/entry-unavailable.tsx";
import {
  isExplicitlySignedOut,
  safeRequestReference
} from "../../lib/api/presentation-error.ts";
import { createServerApiClient } from "../../lib/api/server-client.ts";

export default async function AuthenticatedLayout({
  children
}: Readonly<{ children: ReactNode }>) {
  try {
    const client = await createServerApiClient();
    const current = await getCurrentUser(client);

    return (
      <div className="authenticated-shell">
        <header className="authenticated-shell__header">
          <div>
            <p className="eyebrow">Authenticated workspace</p>
            <p className="authenticated-shell__identity">
              Signed in as <strong>{current.data.user.display_name}</strong>
            </p>
          </div>
          <p className="authenticated-shell__email">{current.data.user.email}</p>
        </header>
        {children}
      </div>
    );
  } catch (error) {
    if (isExplicitlySignedOut(error)) {
      redirect("/sign-in");
    }

    return (
      <EntryUnavailable
        description="NURITEO could not verify your session. Retry when the Core service is available."
        reference={safeRequestReference(error)}
        retryHref="/workspaces"
        title="Your workspace is temporarily unavailable"
      />
    );
  }
}
