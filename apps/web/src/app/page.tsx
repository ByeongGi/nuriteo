import { getCurrentUser, getSetupStatus } from "@nuriteo/api-client";
import { redirect } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { HomeEntry } from "#src/app/_components/home-entry.tsx";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import {
  isExplicitlySignedOut,
  safeRequestReference
} from "#src/lib/api/presentation-error.ts";

export default async function HomePage() {
  let client: Awaited<ReturnType<typeof createServerApiClient>>;

  try {
    client = await createServerApiClient();
  } catch (error) {
    return <HomeServiceUnavailable error={error} />;
  }

  const [setupResult, currentUserResult] = await Promise.allSettled([
    getSetupStatus(client),
    getCurrentUser(client)
  ]);

  if (setupResult.status === "rejected") {
    return <HomeServiceUnavailable error={setupResult.reason} />;
  }
  if (setupResult.value.data.bootstrapRequired) redirect("/setup");
  if (currentUserResult.status === "fulfilled") redirect("/workspaces");
  if (!isExplicitlySignedOut(currentUserResult.reason)) {
    return <HomeServiceUnavailable error={currentUserResult.reason} />;
  }

  return <HomeEntry />;
}

function HomeServiceUnavailable({ error }: { readonly error: unknown }) {
  return (
    <EntryUnavailable
      description="누리터 서비스 상태를 확인하지 못했습니다. 설정 변경은 적용하지 않았습니다."
      reference={safeRequestReference(error)}
      retryHref="/"
      title="서비스 상태를 확인할 수 없습니다"
    />
  );
}
