import { getCurrentUser, getMfaStatus } from "@nuriteo/api-client";
import { redirect } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { MfaSecurity } from "#src/app/mfa/security.tsx";
import { signInHref } from "#src/app/sign-in/return-to.ts";
import {
  isExplicitlySignedOut,
  safeRequestReference
} from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";

export type MfaRouteMode = "challenge" | "setup";

export async function MfaRoute({ mode }: { readonly mode: MfaRouteMode }) {
  const routeHref = `/mfa/${mode}`;
  let current: Awaited<ReturnType<typeof getCurrentUser>>;
  let status: Awaited<ReturnType<typeof getMfaStatus>>;

  try {
    const client = await createServerApiClient();
    [current, status] = await Promise.all([
      getCurrentUser(client),
      getMfaStatus(client)
    ]);
  } catch (error) {
    if (isExplicitlySignedOut(error)) redirect(signInHref(routeHref));
    return (
      <EntryUnavailable
        title="보안 설정을 일시적으로 사용할 수 없습니다"
        description="MFA 상태를 안전하게 불러오지 못했습니다. 변경된 자격 증명은 없습니다."
        reference={safeRequestReference(error)}
        retryHref={routeHref}
      />
    );
  }

  if (status.data.localAccount) {
    if (mode === "setup" && status.data.enrolled) redirect("/mfa/challenge");
    if (mode === "challenge" && !status.data.enrolled) redirect("/mfa/setup");
  }

  return (
    <MfaSecurity
      displayName={current.data.user.display_name}
      status={status.data}
      view={mode}
    />
  );
}
