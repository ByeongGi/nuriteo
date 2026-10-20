"use client";

import { acceptOrganizationInvitation, declineOrganizationInvitation } from "@nuriteo/api-client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button } from "../../../../components/ui/button.tsx";
import { ProductEntryShell } from "../../../_components/product-entry-shell.tsx";
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

  return (
    <ProductEntryShell
      compact
      description="수락하면 조직 워크스페이스가 내 워크스페이스 선택 목록에 추가됩니다."
      eyebrow="조직 초대"
      title="공유 워크스페이스에 참여하세요"
      titleId="organization-invitation-title"
    >
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="record-actions entry-invitation-actions">
        <Button type="button" variant="primary" disabled={mutation.isPending} onClick={() => void respond("accept")}>초대 수락</Button>
        <Button type="button" disabled={mutation.isPending} onClick={() => void respond("decline")}>거절</Button>
      </div>
    </ProductEntryShell>
  );
}
