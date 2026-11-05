"use client";

import { useState } from "react";

import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { ApiError } from "@/services/http/api.ts";
import { unlinkOidcIdentity } from "@/services/oidc/api.ts";

import type { OidcIdentity } from "@nuriteo/api-client";

export function useIdentityConnections(initialIdentities: readonly OidcIdentity[]) {
  const mutation = useExclusiveMutation();
  const [identities, setIdentities] = useState(initialIdentities);
  const [message, setMessage] = useState<{ readonly error: boolean; readonly text: string }>();
  const [pendingIdentity, setPendingIdentity] = useState<OidcIdentity>();

  async function unlink(identity: OidcIdentity) {
    await mutation.run(async () => {
      setMessage(undefined);
      try {
        await unlinkOidcIdentity(createBrowserApiClient(), identity.providerId, { csrfToken: readCsrfCredential() });
        setIdentities((items) => items.filter((item) => item.providerId !== identity.providerId));
        setPendingIdentity(undefined);
        setMessage({ error: false, text: `${identity.providerDisplayName} 연결을 해제하고 브라우저 세션을 안전하게 갱신했습니다.` });
      } catch (error) {
        setMessage({
          error: true,
          text: error instanceof ApiError && error.status === 409
            ? "사용할 수 있는 로그인 수단을 하나 이상 유지해야 합니다."
            : "계정 연결을 해제하지 못했습니다. 다시 로그인한 뒤 시도하세요."
        });
      }
    });
  }

  function confirmUnlink() {
    if (pendingIdentity) void unlink(pendingIdentity);
  }

  return {
    cancelUnlink: () => setPendingIdentity(undefined),
    confirmUnlink,
    identities,
    isPending: mutation.isPending,
    message,
    pendingIdentity,
    requestUnlink: setPendingIdentity
  };
}
