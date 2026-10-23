import { getCurrentUser, getMfaStatus } from "@nuriteo/api-client";
import { cookies, headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import type { ReactNode } from "react";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import {
  isExplicitlySignedOut,
  safeRequestReference
} from "#src/lib/api/presentation-error.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { parseThemeMode, THEME_COOKIE_NAME } from "#src/lib/theme.ts";
import { AdminAccessRequired } from "#src/app/(admin)/admin/_components/admin-access-required.tsx";
import { AdminShellFrame, AdminShellLoading } from "#src/app/(admin)/admin/admin-shell-frame.tsx";
import { signInHref } from "#src/app/sign-in/return-to.ts";

export default function AdminLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <Suspense fallback={<AdminShellLoading />}>
      <AdminSessionBoundary>{children}</AdminSessionBoundary>
    </Suspense>
  );
}

async function AdminSessionBoundary({ children }: Readonly<{ children: ReactNode }>) {
  try {
    const client = await createServerApiClient();
    const [current, mfa] = await Promise.all([
      getCurrentUser(client),
      getMfaStatus(client)
    ]);

    if (mfa.data.restricted) redirect("/mfa");
    if (!current.data.user.is_instance_admin) {
      return (
        <AdminAccessRequired description="관리자 홈은 인스턴스 관리자 권한이 있는 계정만 사용할 수 있습니다." />
      );
    }

    const cookieStore = await cookies();
    const themeMode = parseThemeMode(cookieStore.get(THEME_COOKIE_NAME)?.value);

    return (
      <AdminShellFrame
        displayName={current.data.user.display_name}
        email={current.data.user.email}
        themeMode={themeMode}
      >
        {children}
      </AdminShellFrame>
    );
  } catch (error) {
    unstable_rethrow(error);
    if (isExplicitlySignedOut(error)) {
      const requestPath = (await headers()).get("x-nuriteo-request-path") ?? "/admin";
      redirect(signInHref(requestPath));
    }

    return (
      <EntryUnavailable
        description="관리자 세션을 확인하지 못했습니다. Core 서비스 상태를 확인한 뒤 다시 시도하세요."
        reference={safeRequestReference(error)}
        retryHref="/admin"
        title="관리자 홈을 일시적으로 사용할 수 없습니다"
      />
    );
  }
}
