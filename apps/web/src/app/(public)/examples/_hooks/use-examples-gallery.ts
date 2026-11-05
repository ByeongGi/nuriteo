"use client";

import { useDeferredValue, useMemo, useState } from "react";

import type { PublicPublishedExample } from "@nuriteo/api-client";
import type { ChangeEvent } from "react";

type VisibilityFilter = "all" | PublicPublishedExample["visibility"];

export function useExamplesGallery(examples: readonly PublicPublishedExample[]) {
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

  function onQueryChange(event: ChangeEvent<HTMLInputElement>) {
    setQuery(event.currentTarget.value);
  }

  function onVisibilityChange(value: VisibilityFilter) {
    setVisibility(value);
  }

  return {
    isFiltering,
    onQueryChange,
    onVisibilityChange,
    query,
    visibility,
    visibilityCounts,
    visibleExamples
  };
}
