import { getCurrentUser, getMfaPolicy } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "../../../_components/entry-unavailable.tsx";
import { safeRequestReference } from "../../../../lib/api/presentation-error.ts";
import { createServerApiClient } from "../../../../lib/api/server-client.ts";
import { MfaPolicyEditor } from "./policy-editor.tsx";

export const metadata: Metadata = { title: "MFA policy" };

export default async function AdminMfaPage() {
  try {
    const client = await createServerApiClient();
    const [current, policy] = await Promise.all([getCurrentUser(client), getMfaPolicy(client)]);
    if (!current.data.user.is_instance_admin) {
      return <main id="main-content" className="workspace-page"><h1>Administrator access required</h1></main>;
    }
    return <MfaPolicyEditor key={policy.data.version} initial={policy.data} />;
  } catch (error) {
    return <EntryUnavailable title="MFA policy is temporarily unavailable" description="The policy could not be loaded safely. No deadline was changed." reference={safeRequestReference(error)} retryHref="/admin/mfa" />;
  }
}

