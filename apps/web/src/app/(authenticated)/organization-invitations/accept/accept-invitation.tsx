"use client";

import { acceptOrganizationInvitation, declineOrganizationInvitation } from "@nuriteo/api-client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { tv } from "tailwind-variants";

import { Button } from "#src/components/ui/button.tsx";
import { ProductEntryShell } from "#src/app/_components/product-entry-shell.tsx";
import { collaborationError, readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

const invitationStyles = tv({
  slots: {
    error: "mt-5 rounded-lg border border-danger/25 bg-danger-subtle px-4 py-3 text-sm text-danger",
    actions: "mt-6 flex flex-wrap gap-2 border-t border-muted-border pt-5 max-[32rem]:grid max-[32rem]:[&>button]:w-full"
  }
});

export function AcceptInvitation() {
  const styles = invitationStyles();
  const router = useRouter();
  const token = useSearchParams().get("token");
  const mutation = useExclusiveMutation();
  const [error, setError] = useState<string>();

  async function respond(action: "accept" | "decline") {
    if (token === null) { setError("초대 링크가 없거나 올바르지 않습니다."); return; }
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
      {error ? <p className={styles.error()} role="alert">{error}</p> : null}
      <div className={styles.actions()}>
        <Button type="button" variant="primary" disabled={mutation.isPending} onClick={() => void respond("accept")}>초대 수락</Button>
        <Button type="button" disabled={mutation.isPending} onClick={() => void respond("decline")}>거절</Button>
      </div>
    </ProductEntryShell>
  );
}
