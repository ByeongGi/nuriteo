"use client";

import type { PublicPublishedExample } from "@nuriteo/api-client";

import { useExamplesGallery } from "@/app/(public)/examples/_hooks/use-examples-gallery.ts";
import { ExampleCard } from "@/app/(public)/examples/_components/example-card.tsx";
import { examplesStyles } from "@/app/(public)/examples/_components/examples.styles.ts";
import { SearchField } from "@/components/ui/search-field.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";

export function ExamplesGallery({ examples }: { readonly examples: readonly PublicPublishedExample[] }) {
  const styles = examplesStyles();
  const {
    isFiltering,
    onQueryChange,
    onVisibilityChange,
    query,
    visibility,
    visibilityCounts,
    visibleExamples
  } = useExamplesGallery(examples);

  return (
    <div className={styles.body()}>
      <section className={styles.toolbar()} aria-label="공개 예제 검색 및 필터">
        <SearchField className={styles.search()} label="예제 검색" value={query} onChange={onQueryChange} placeholder="이름 또는 버전 검색" />
        <SegmentedControl
          aria-label="공개 범위"
          value={visibility}
          onValueChange={onVisibilityChange}
          options={[
            { value: "all", label: `전체 ${examples.length}` },
            { value: "public", label: `공개 ${visibilityCounts.public}` },
            { value: "unlisted", label: `링크 공개 ${visibilityCounts.unlisted}` }
          ]}
        />
      </section>

      <p className={styles.resultCount()} aria-live="polite" aria-atomic="true">
        {isFiltering ? "검색 결과를 갱신하는 중" : `${visibleExamples.length}개 표시 · 전체 ${examples.length}개`}
      </p>

      {visibleExamples.length === 0 ? (
        <section className={styles.empty()} aria-labelledby="empty-examples-title">
          <h2 className={styles.emptyTitle()} id="empty-examples-title">{(function () {
    if (examples.length === 0) {
        return ("아직 공개된 예제가 없습니다");
    }
    return ("검색 결과가 없습니다");
})()}</h2>
          <p className={styles.emptyDescription()}>{(function () {
    if (examples.length === 0) {
        return ("프로젝트의 고정 버전을 게시하면 이곳에 표시됩니다.");
    }
    return ("검색어나 공개 범위를 바꿔보세요.");
})()}</p>
        </section>
      ) : (
        <section className={styles.grid()} data-filtering={isFiltering} aria-label="공개 예제" aria-busy={isFiltering}>
          {visibleExamples.map((example) => <ExampleCard key={example.publicId} example={example} />)}
        </section>
      )}
    </div>
  );
}
