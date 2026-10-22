"use client";

import { useDeferredValue, useMemo } from "react";

import type { RuntimeWorkspaceFile } from "#src/runtime/runtime-adapter.ts";

interface ProjectFileSearchInput {
  readonly files: readonly RuntimeWorkspaceFile[];
  readonly limit: number;
  readonly query: string;
  readonly selectedPath?: string | undefined;
}

interface ProjectFileSearchResult {
  readonly hasMoreFiles: boolean;
  readonly isSearchPending: boolean;
  readonly matchingFiles: readonly RuntimeWorkspaceFile[];
  readonly visibleFiles: readonly RuntimeWorkspaceFile[];
}

export function useProjectFileSearch({
  files,
  limit,
  query,
  selectedPath
}: ProjectFileSearchInput): ProjectFileSearchResult {
  const deferredQuery = useDeferredValue(query);
  const normalizedQuery = deferredQuery.trim().toLocaleLowerCase();

  const matchingFiles = useMemo(() => {
    if (normalizedQuery.length === 0) return files;
    return files.filter((file) => file.path.toLocaleLowerCase().includes(normalizedQuery));
  }, [files, normalizedQuery]);

  const visibleFiles = useMemo(() => {
    const batch = matchingFiles.slice(0, limit);
    const selectedFileIsVisible = batch.some((file) => file.path === selectedPath);
    if (normalizedQuery.length > 0 || !selectedPath || selectedFileIsVisible) return batch;

    const selectedFile = files.find((file) => file.path === selectedPath);
    if (!selectedFile || batch.length === 0) return batch;
    return [selectedFile, ...batch.slice(0, -1)];
  }, [files, limit, matchingFiles, normalizedQuery.length, selectedPath]);

  return {
    hasMoreFiles: visibleFiles.length < matchingFiles.length,
    isSearchPending: query !== deferredQuery,
    matchingFiles,
    visibleFiles
  };
}
