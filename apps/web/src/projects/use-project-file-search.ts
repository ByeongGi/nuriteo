"use client";

import { useDeferredValue, useMemo } from "react";

import type { RuntimeWorkspaceFile } from "#src/runtime/runtime-adapter.ts";

interface ProjectFileSearchInput {
  readonly files: readonly RuntimeWorkspaceFile[];
  readonly limit: number;
  readonly matchCase?: boolean;
  readonly query: string;
  readonly useRegularExpression?: boolean;
  readonly selectedPath?: string | undefined;
}

interface ProjectFileSearchResult {
  readonly hasMoreFiles: boolean;
  readonly isSearchPending: boolean;
  readonly matchingFiles: readonly RuntimeWorkspaceFile[];
  readonly searchError?: string | undefined;
  readonly visibleFiles: readonly RuntimeWorkspaceFile[];
}

export interface ProjectContentSearchMatch {
  readonly column: number;
  readonly line: number;
  readonly path: string;
  readonly snippet: string;
}

interface ProjectContentSearchInput {
  readonly files: readonly RuntimeWorkspaceFile[];
  readonly limit: number;
  readonly matchCase?: boolean;
  readonly query: string;
  readonly readText: (path: string) => string;
  readonly selectedContent?: string | undefined;
  readonly selectedPath?: string | undefined;
  readonly useRegularExpression?: boolean;
}

export function useProjectFileSearch({
  files,
  limit,
  matchCase = false,
  query,
  useRegularExpression = false,
  selectedPath
}: ProjectFileSearchInput): ProjectFileSearchResult {
  const deferredQuery = useDeferredValue(query);
  const trimmedQuery = deferredQuery.trim();

  const searchExpression = useMemo(() => {
    if (!useRegularExpression || trimmedQuery.length === 0) return undefined;
    try {
      return new RegExp(trimmedQuery, matchCase ? "u" : "iu");
    } catch {
      return null;
    }
  }, [matchCase, trimmedQuery, useRegularExpression]);

  const matchingFiles = useMemo(() => {
    if (trimmedQuery.length === 0) return files;
    if (searchExpression === null) return [];
    if (searchExpression !== undefined) {
      return files.filter((file) => searchExpression.test(file.path));
    }

    const expectedPath = matchCase ? trimmedQuery : trimmedQuery.toLocaleLowerCase();
    return files.filter((file) => {
      const candidatePath = matchCase ? file.path : file.path.toLocaleLowerCase();
      return candidatePath.includes(expectedPath);
    });
  }, [files, matchCase, searchExpression, trimmedQuery]);

  const visibleFiles = useMemo(() => {
    const batch = matchingFiles.slice(0, limit);
    const selectedFileIsVisible = batch.some((file) => file.path === selectedPath);
    if (trimmedQuery.length > 0 || !selectedPath || selectedFileIsVisible) return batch;

    const selectedFile = files.find((file) => file.path === selectedPath);
    if (!selectedFile || batch.length === 0) return batch;
    return [selectedFile, ...batch.slice(0, -1)];
  }, [files, limit, matchingFiles, selectedPath, trimmedQuery.length]);

  return {
    hasMoreFiles: visibleFiles.length < matchingFiles.length,
    isSearchPending: query !== deferredQuery,
    matchingFiles,
    searchError: searchExpression === null ? "올바른 정규식을 입력하세요." : undefined,
    visibleFiles
  };
}

export function useProjectContentSearch({
  files,
  limit,
  matchCase = false,
  query,
  readText,
  selectedContent,
  selectedPath,
  useRegularExpression = false
}: ProjectContentSearchInput): {
  readonly isSearchPending: boolean;
  readonly matches: readonly ProjectContentSearchMatch[];
  readonly searchError?: string | undefined;
  readonly totalMatches: number;
} {
  const deferredQuery = useDeferredValue(query);
  const trimmedQuery = deferredQuery.trim();
  const searchExpression = useMemo(() => {
    if (!useRegularExpression || trimmedQuery.length === 0) return undefined;
    try {
      return new RegExp(trimmedQuery, matchCase ? "gu" : "giu");
    } catch {
      return null;
    }
  }, [matchCase, trimmedQuery, useRegularExpression]);

  const allMatches = useMemo(() => {
    if (trimmedQuery.length === 0 || searchExpression === null) return [];
    const matches: ProjectContentSearchMatch[] = [];
    for (const file of files) {
      if (file.kind !== "text") continue;
      let content: string;
      try {
        content = file.path === selectedPath && selectedContent !== undefined ? selectedContent : readText(file.path);
      } catch {
        continue;
      }
      for (const [lineIndex, lineText] of content.split("\n").entries()) {
        if (searchExpression !== undefined) {
          searchExpression.lastIndex = 0;
          for (const match of lineText.matchAll(searchExpression)) {
            matches.push({ column: (match.index ?? 0) + 1, line: lineIndex + 1, path: file.path, snippet: lineText.trim() });
          }
          continue;
        }
        const candidate = matchCase ? lineText : lineText.toLocaleLowerCase();
        const expected = matchCase ? trimmedQuery : trimmedQuery.toLocaleLowerCase();
        let column = candidate.indexOf(expected);
        while (column >= 0) {
          matches.push({ column: column + 1, line: lineIndex + 1, path: file.path, snippet: lineText.trim() });
          column = candidate.indexOf(expected, column + Math.max(expected.length, 1));
        }
      }
    }
    return matches;
  }, [files, matchCase, readText, searchExpression, selectedContent, selectedPath, trimmedQuery]);

  return {
    isSearchPending: query !== deferredQuery,
    matches: allMatches.slice(0, limit),
    searchError: searchExpression === null ? "올바른 정규식을 입력하세요." : undefined,
    totalMatches: allMatches.length
  };
}
