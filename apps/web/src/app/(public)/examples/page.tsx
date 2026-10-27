import { listPublicPublishedExamples } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "#src/app/_components/entry-unavailable.tsx";
import { safeRequestReference } from "#src/lib/api/presentation-error.ts";
import { createPublicServerApiClient } from "#src/lib/api/public-server-client.ts";
import { PublicExamplesScreen } from "#src/app/(public)/examples/_components/public-examples-screen.tsx";

export const metadata: Metadata = {
  description: "누리터에서 게시된 읽기 전용 고정 버전을 살펴보고 내 워크스페이스로 복제하세요.",
  title: "공개 예제"
};

export default async function ExamplesPage() {
  try {
    const result = await listPublicPublishedExamples(createPublicServerApiClient(), { limit: 100 });
    return <PublicExamplesScreen examples={result.data.items} />;
  } catch (error) {
    return (
      <EntryUnavailable
        description="공개 예제를 안전하게 불러오지 못했습니다. 로그인 정보나 비공개 프로젝트 데이터는 요청하지 않았습니다."
        reference={safeRequestReference(error)}
        retryHref="/examples"
        title="공개 예제를 일시적으로 사용할 수 없습니다"
      />
    );
  }
}
