import { getCurrentUser, getMfaStatus } from "@nuriteo/api-client";
import { redirect, unstable_rethrow } from "next/navigation";
import type { ReactNode } from "react";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
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
    if (isExplicitlySignedOut(error)) redirect("/sign-in");
    return (
      <EntryUnavailable
        title="Studio를 열 수 없습니다"
        description="세션을 확인하지 못했습니다. 잠시 후 다시 시도해주세요."
        reference={safeRequestReference(error)}
        retryHref="/projects"
      />
    );
  }

  return <div className="studio-route">{children}</div>;
}
