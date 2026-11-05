import { redirect } from "next/navigation";

import { getMfaStatus } from "@/services/mfa/api.ts";
import { getCurrentUser } from "@/services/session/api.ts";
import { signInHref } from "@/app/(public)/sign-in/_utils/return-to.ts";
import {
  isExplicitlySignedOut,
  safeRequestReference
} from "@/lib/api/presentation-error.ts";
import { createServerApiClient } from "@/lib/api/server-client.ts";

import type { MfaStatus } from "@nuriteo/api-client";

export type MfaRouteMode = "challenge" | "setup";

export type MfaRouteLoad =
  | {
      readonly description: string;
      readonly kind: "unavailable";
      readonly reference: string | undefined;
      readonly retryHref: string;
      readonly title: string;
    }
  | {
      readonly displayName: string;
      readonly kind: "ready";
      readonly status: MfaStatus;
    };

export async function loadMfaRoute(mode: MfaRouteMode): Promise<MfaRouteLoad> {
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
    return {
      description: "MFA 상태를 안전하게 불러오지 못했습니다. 변경된 자격 증명은 없습니다.",
      kind: "unavailable",
      reference: safeRequestReference(error),
      retryHref: routeHref,
      title: "보안 설정을 일시적으로 사용할 수 없습니다"
    };
  }

  if (status.data.localAccount) {
    if (mode === "setup" && status.data.enrolled) redirect("/mfa/challenge");
    if (mode === "challenge" && !status.data.enrolled) redirect("/mfa/setup");
  }
  return {
    displayName: current.data.user.display_name,
    kind: "ready",
    status: status.data
  };
}
