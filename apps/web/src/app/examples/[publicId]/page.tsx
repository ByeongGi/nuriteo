import { ApiError, getPublicPublishedExample } from "@nuriteo/api-client";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createPublicServerApiClient } from "#src/lib/api/public-server-client.ts";
import { publicIdPathSegment } from "#src/lib/published-example-path.ts";
import { PublicExampleDetail } from "#src/app/examples/_components/public-example-detail.tsx";

export const metadata: Metadata = { title: "공개 예제" };

interface Props {
  readonly params: Promise<{ readonly publicId: string }>;
}

export default async function ExampleDetailPage({ params }: Props) {
  const { publicId } = await params;
  if (publicIdPathSegment(publicId) === undefined) notFound();
  try {
    const { data: example } = await getPublicPublishedExample(createPublicServerApiClient(), { publicId });
    return <PublicExampleDetail example={example} />;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    return (
      <EntryUnavailable
        description="공개 예제를 안전하게 불러오지 못했습니다. 비공개 프로젝트 데이터는 요청하지 않았습니다."
        reference={safeRequestReference(error)}
        retryHref={`/examples/${encodeURIComponent(publicId)}`}
        title="예제를 일시적으로 사용할 수 없습니다"
      />
    );
  }
}
