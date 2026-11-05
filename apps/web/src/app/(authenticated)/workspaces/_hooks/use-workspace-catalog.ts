"use client";

import { useDeferredValue, useMemo, useState } from "react";

import type { Workspace } from "@nuriteo/api-client";

type WorkspaceFilter = "all" | Workspace["ownerType"];

const WORKSPACE_FILTER_THRESHOLD = 8;

export function useWorkspaceCatalog(workspaces: readonly Workspace[]) {
  const [filter, setFilter] = useState<WorkspaceFilter>("all");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const catalog = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLocaleLowerCase("ko-KR");
    let personalCount = 0;
    const filteredWorkspaces: Workspace[] = [];

    for (const workspace of workspaces) {
      if (workspace.ownerType === "user") personalCount += 1;
      const matchesType = filter === "all" || workspace.ownerType === filter;
      const matchesQuery = normalizedQuery === ""
        || workspace.displayLabel.toLocaleLowerCase("ko-KR").includes(normalizedQuery);
      if (matchesType && matchesQuery) filteredWorkspaces.push(workspace);
    }

    return {
      filteredWorkspaces,
      organizationCount: workspaces.length - personalCount,
      personalCount
    };
  }, [deferredQuery, filter, workspaces]);

  return {
    catalog,
    filter,
    isFiltering: query !== deferredQuery,
    query,
    setFilter,
    setQuery,
    showFilters: workspaces.length >= WORKSPACE_FILTER_THRESHOLD
  };
}
