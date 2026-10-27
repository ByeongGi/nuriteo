"use client";

import type { PublicPublishedExample } from "@nuriteo/api-client";
import { useDeferredValue, useMemo, useState } from "react";

import { SegmentedControl } from "#src/components/ui/segmented-control.tsx";
import { SearchField } from "#src/components/ui/search-field.tsx";
import { ExampleCard } from "#src/app/(public)/examples/_components/example-card.tsx";
import { examplesStyles } from "#src/app/(public)/examples/_components/examples.styles.ts";

type VisibilityFilter = "all" | PublicPublishedExample["visibility"];

export function ExamplesGallery({ examples }: { readonly examples: readonly PublicPublishedExample[] }) {
  const styles = examplesStyles();
  const [query, setQuery] = useState("");
  const [visibility, setVisibility] = useState<VisibilityFilter>("all");
  const deferredQuery = useDeferredValue(query);
  const normalizedQuery = deferredQuery.trim().toLocaleLowerCase("ko-KR");
  const visibilityCounts = useMemo(() => {
    let publicCount = 0;
    let unlistedCount = 0;
    for (const example of examples) {
      if (example.visibility === "public") publicCount += 1;
      else unlistedCount += 1;
    }
    return { public: publicCount, unlisted: unlistedCount };
  }, [examples]);
  const visibleExamples = useMemo(() => examples.filter((example) => {
    const matchesVisibility = visibility === "all" || example.visibility === visibility;
    const searchText = `${example.name} v${example.versionNumber}`.toLocaleLowerCase("ko-KR");
    return matchesVisibility && (normalizedQuery === "" || searchText.includes(normalizedQuery));
  }), [examples, normalizedQuery, visibility]);
  const isFiltering = query !== deferredQuery;

  return (
    <div className={styles.body()}>
      <section className={styles.toolbar()} aria-label="공개 예제 검색 및 필터">
        <SearchField className={styles.search()} label="예제 검색" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="이름 또는 버전 검색" />
        <SegmentedControl
          aria-label="공개 범위"
          value={visibility}
          onValueChange={setVisibility}
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
          <h2 className={styles.emptyTitle()} id="empty-examples-title">{examples.length === 0 ? "아직 공개된 예제가 없습니다" : "검색 결과가 없습니다"}</h2>
          <p className={styles.emptyDescription()}>{examples.length === 0 ? "프로젝트의 고정 버전을 게시하면 이곳에 표시됩니다." : "검색어나 공개 범위를 바꿔보세요."}</p>
        </section>
      ) : (
        <section className={styles.grid()} data-filtering={isFiltering} aria-label="공개 예제" aria-busy={isFiltering}>
          {visibleExamples.map((example) => <ExampleCard key={example.publicId} example={example} />)}
        </section>
      )}
    </div>
  );
}
