import { listRegistries } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { RegistryConsole } from "#src/app/(admin)/admin/integrations/registries/registry-console.tsx";
import { createServerApiClient } from "#src/lib/api/server-client.ts";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";

export const metadata: Metadata = { title: "패키지 저장소" };

export default async function RegistriesPage() {
  try {
    const configuration = await listRegistries(await createServerApiClient());
    return <RegistryConsole initialConfiguration={configuration.data} />;
  } catch (error) {
    return <EntryUnavailable title="패키지 저장소를 일시적으로 사용할 수 없습니다" description="변경된 저장소 경로나 자격 증명은 없습니다." reference={safeRequestReference(error)} retryHref="/admin/integrations/registries" />;
  }
}
