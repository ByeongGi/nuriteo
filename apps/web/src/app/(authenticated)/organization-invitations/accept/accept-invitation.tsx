"use client";

import { acceptOrganizationInvitation, declineOrganizationInvitation } from "@nuriteo/api-client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button } from "../../../../components/ui/button.tsx";
import { collaborationError, readCsrfCredential } from "../../../../lib/api/browser-security.ts";
import { createBrowserApiClient } from "../../../../lib/api/browser-client.ts";
import { useExclusiveMutation } from "../../../../lib/use-exclusive-mutation.ts";

export function AcceptInvitation() {
  const router = useRouter();
  const token = useSearchParams().get("token");
  const mutation = useExclusiveMutation();
  const [error, setError] = useState<string>();

  async function respond(action: "accept" | "decline") {
    if (token === null) { setError("This invitation link is missing or invalid."); return; }
    await mutation.run(async () => {
      setError(undefined);
      try {
        const client = createBrowserApiClient();
        const options = { csrfToken: readCsrfCredential() };
        if (action === "accept") await acceptOrganizationInvitation(client, token, options);
        else await declineOrganizationInvitation(client, token, options);
        router.replace(
          action === "accept"
            ? "/workspaces?joined=1"
            : "/workspaces?invitation=declined"
        );
        router.refresh();
      } catch (cause) {
        setError(collaborationError(cause, "organization-invitation-terminal"));
      }
    });
  }

  return <main id="main-content" className="entry-page"><section className="entry-card"><p className="eyebrow">Organization invitation</p><h1>Join a shared Workspace</h1><p className="entry-description">Accept to add the Organization Workspace to your selector.</p>{error ? <p className="form-error" role="alert">{error}</p> : null}<div className="record-actions"><Button type="button" variant="primary" disabled={mutation.isPending} onClick={() => void respond("accept")}>Accept invitation</Button><Button type="button" disabled={mutation.isPending} onClick={() => void respond("decline")}>Decline</Button></div></section></main>;
}
