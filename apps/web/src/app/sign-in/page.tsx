import { getCurrentUser, listOidcLoginProviders } from "@nuriteo/api-client";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { SignInForm } from "#src/app/sign-in/sign-in-form.tsx";
import { safeReturnTo } from "#src/app/sign-in/return-to.ts";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import {
  isExplicitlySignedOut,
  safeRequestReference
} from "#src/lib/api/presentation-error.ts";

export const metadata: Metadata = {
  title: "로그인"
};

interface SignInSearchParams {
  readonly activated?: string;
  readonly oidc?: string;
  readonly reauthenticate?: string;
  readonly returnTo?: string;
}

export default async function SignInPage({ searchParams }: { readonly searchParams: Promise<SignInSearchParams> }) {
  const query = await searchParams;
  const activated = query.activated === "1";
  const oidcFailed = query.oidc === "failed";
  const reauthentication = query.reauthenticate === "1";
  const returnTo = safeReturnTo(query.returnTo);
  try {
    const client = await createServerApiClient();
    await getCurrentUser(client);
  } catch (error) {
    if (isExplicitlySignedOut(error)) {
      try {
        const providers = await listOidcLoginProviders(await createServerApiClient());
        return <SignInForm activated={activated} providers={providers.data} oidcFailed={oidcFailed} reauthentication={reauthentication} returnTo={returnTo} />;
      } catch {
        return <SignInForm activated={activated} providers={[]} providersLoadFailed oidcFailed={oidcFailed} reauthentication={reauthentication} returnTo={returnTo} />;
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

  if (reauthentication) {
    try {
      const providers = await listOidcLoginProviders(await createServerApiClient());
      return <SignInForm providers={providers.data} oidcFailed={oidcFailed} reauthentication returnTo={returnTo} />;
    } catch {
      return <SignInForm providers={[]} providersLoadFailed oidcFailed={oidcFailed} reauthentication returnTo={returnTo} />;
    }
  }

  redirect(returnTo);
}
