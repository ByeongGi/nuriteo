import type { PublicPublishedExample } from "@nuriteo/api-client";

import { ExamplesGallery } from "#src/app/examples/_components/examples-gallery.tsx";
import { examplesStyles } from "#src/app/examples/_components/examples.styles.ts";
import { PageHeader } from "#src/components/ui/page-header.tsx";

export interface PublicExamplesScreenProps {
  readonly examples: readonly PublicPublishedExample[];
}

export function PublicExamplesScreen({ examples }: PublicExamplesScreenProps) {
  const styles = examplesStyles();
  return (
    <main id="main-content" className={styles.page()} tabIndex={-1}>
      <PageHeader
        eyebrow="커뮤니티 / 읽기 전용"
        title="공개 예제"
        description="공개된 고정 버전을 안전하게 살펴보고 내 워크스페이스로 복제하세요."
        actions={<span className={styles.headerNote()}>원본 프로젝트와 분리된 읽기 전용 스냅샷</span>}
      />
      <ExamplesGallery examples={examples} />
    </main>
  );
}
