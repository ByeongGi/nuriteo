import type { PublicPublishedExample } from "@nuriteo/api-client";

import { ExamplesGallery } from "#src/app/examples/_components/examples-gallery.tsx";

export interface PublicExamplesScreenProps {
  readonly examples: readonly PublicPublishedExample[];
}

export function PublicExamplesScreen({ examples }: PublicExamplesScreenProps) {
  return (
    <main id="main-content" className="public-examples" tabIndex={-1}>
      <header className="public-examples__header">
        <div>
          <p className="eyebrow">커뮤니티 / 읽기 전용</p>
          <h1>공개 예제</h1>
          <p>공개된 고정 버전을 안전하게 살펴보고 내 워크스페이스로 복제하세요.</p>
        </div>
        <span>원본 프로젝트와 분리된 읽기 전용 스냅샷</span>
      </header>
      <ExamplesGallery examples={examples} />
    </main>
  );
}
