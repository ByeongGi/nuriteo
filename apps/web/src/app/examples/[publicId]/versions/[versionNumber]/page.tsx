import { ApiError, getPublicPublishedExampleVersion } from "@nuriteo/api-client";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EntryUnavailable } from "../../../../_components/entry-unavailable.tsx";
import { safeRequestReference } from "../../../../../lib/api/presentation-error.ts";
import { createPublicServerApiClient } from "../../../../../lib/api/public-server-client.ts";
import {
  publicIdPathSegment,
  publicVersionPathSegment
} from "../../../../../lib/published-example-path.ts";
import { previewOriginConfiguration } from "../../../../../lib/preview/config.ts";
import { ReadOnlyExampleShell } from "../../../_components/read-only-example-shell.tsx";

export const metadata: Metadata = { title: "Read-only example" };

interface Props {
  readonly params: Promise<{
    readonly publicId: string;
    readonly versionNumber: string;
  }>;
}

export default async function FixedExampleVersionPage({ params }: Props) {
  const { publicId, versionNumber: rawVersionNumber } = await params;
  const versionNumber = publicVersionPathSegment(rawVersionNumber);
  if (publicIdPathSegment(publicId) === undefined || versionNumber === undefined) {
    notFound();
  }

  try {
    const { data: example } = await getPublicPublishedExampleVersion(
      createPublicServerApiClient(),
      { publicId, versionNumber }
    );
    return (
      <ReadOnlyExampleShell
        example={example}
        previewConfiguration={previewOriginConfiguration()}
      />
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    return (
      <EntryUnavailable
        description="This fixed example version could not be loaded safely. No private project data was requested."
        reference={safeRequestReference(error)}
        retryHref={`/examples/${encodeURIComponent(publicId)}/versions/${encodeURIComponent(rawVersionNumber)}`}
        title="Example version is temporarily unavailable"
      />
    );
  }
}
