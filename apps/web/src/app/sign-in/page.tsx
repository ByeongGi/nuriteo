import { getCurrentUser, listOidcLoginProviders } from "@nuriteo/api-client";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { Providers } from "#src/app/providers.tsx";
import { SignInForm } from "#src/app/sign-in/sign-in-form.tsx";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import {
  isExplicitlySignedOut,
  safeRequestReference
} from "#src/lib/api/presentation-error.ts";

export const metadata: Metadata = {
  title: "로그인"
};

export default async function SignInPage({ searchParams }: { readonly searchParams: Promise<{ readonly oidc?: string }> }) {
  const oidcFailed = (await searchParams).oidc === "failed";
  try {
    const client = await createServerApiClient();
    await getCurrentUser(client);
  } catch (error) {
    if (isExplicitlySignedOut(error)) {
      try {
        const providers = await listOidcLoginProviders(await createServerApiClient());
        return <Providers><SignInForm providers={providers.data} oidcFailed={oidcFailed} /></Providers>;
      } catch {
        return <Providers><SignInForm providers={[]} oidcFailed={oidcFailed} /></Providers>;
      }
    }

    return (
      <EntryUnavailable
        description="누리터가 현재 세션을 확인하지 못했습니다. 개발 서버가 준비되면 다시 시도하세요."
        reference={safeRequestReference(error)}
        retryHref="/sign-in"
        title="로그인을 일시적으로 사용할 수 없습니다"
      />
    );
  }

  redirect("/workspaces");
}
