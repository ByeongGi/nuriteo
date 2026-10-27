import { getCurrentUser, getMfaStatus } from "@nuriteo/api-client";
import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import type { ReactNode } from "react";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { signInHref } from "#src/app/(public)/sign-in/return-to.ts";
import { isExplicitlySignedOut, safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export default async function StudioLayout({ children }: Readonly<{ children: ReactNode }>) {
  try {
    const client = await createServerApiClient();
    await getCurrentUser(client);
    const mfa = await getMfaStatus(client);
    if (mfa.data.restricted) redirect("/mfa");
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) {
      const requestPath = (await headers()).get("x-nuriteo-request-path") ?? "/workspaces";
      redirect(signInHref(requestPath));
    }
    return (
      <EntryUnavailable
        title="Studio를 열 수 없습니다"
        description="세션을 확인하지 못했습니다. 잠시 후 다시 시도해주세요."
        reference={safeRequestReference(error)}
        retryHref="/workspaces"
      />
    );
  }

  return <div className="min-h-screen bg-page">{children}</div>;
}
