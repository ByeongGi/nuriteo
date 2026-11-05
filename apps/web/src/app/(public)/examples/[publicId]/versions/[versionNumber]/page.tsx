import { ApiError } from "@/services/http/api.ts";
import { getPublicPublishedExampleVersion } from "@/services/published-examples/api.ts";

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createPublicServerApiClient } from "#src/lib/api/public-server-client.ts";
import {
  publicIdPathSegment,
  publicVersionPathSegment
} from "#src/lib/published-example-path.ts";
import { previewOriginConfiguration } from "#src/lib/preview/config.ts";
import { ReadOnlyExampleShell } from "#src/app/(public)/examples/_components/read-only-example-shell.tsx";

export const metadata: Metadata = { title: "읽기 전용 예제" };

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
        description="이 고정 예제 버전을 안전하게 불러오지 못했습니다. 비공개 프로젝트 데이터에는 접근하지 않았습니다."
        reference={safeRequestReference(error)}
        retryHref={`/examples/${encodeURIComponent(publicId)}/versions/${encodeURIComponent(rawVersionNumber)}`}
        title="예제 버전을 일시적으로 사용할 수 없습니다"
      />
    );
  }
}
