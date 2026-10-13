import { listAccessTokens } from "@nuriteo/api-client";
import type { AccessTokenTarget } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "../../_components/entry-unavailable.tsx";
import { createServerApiClient } from "../../../lib/api/server-client.ts";
import { safeRequestReference } from "../../../lib/api/presentation-error.ts";
import { AccessTokenConsole } from "./token-console.tsx";

export const metadata: Metadata = { title: "Access tokens" };

export default async function AccessTokensPage({
  searchParams
}: {
  readonly searchParams: Promise<{ readonly projectId?: string }>;
}) {
  const projectId = (await searchParams).projectId;
  const target: AccessTokenTarget = projectId === undefined
    ? { kind: "personal" }
    : { kind: "project", projectId };
  try {
    const result = await listAccessTokens(await createServerApiClient(), target);
    return <AccessTokenConsole initialTokens={result.data} target={target} />;
  } catch (error) {
    return (
      <EntryUnavailable
        title="Access tokens are temporarily unavailable"
        description="No credential was issued, changed, or exposed. Check the Project identifier and your administrative access, then retry."
        reference={safeRequestReference(error)}
        retryHref="/access-tokens"
      />
    );
  }
}
