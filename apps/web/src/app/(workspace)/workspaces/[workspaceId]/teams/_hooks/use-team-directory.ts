"use client";

import { useDeferredValue, useMemo, useState } from "react";

import type { Team } from "@nuriteo/api-client";

export function useTeamDirectory(teams: readonly Team[]) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const visibleTeams = useMemo(() => {
    const normalized = deferredQuery.trim().toLocaleLowerCase("ko-KR");
    return normalized === "" ? teams : teams.filter((team) => `${team.displayName} ${team.slug}`.toLocaleLowerCase("ko-KR").includes(normalized));
  }, [deferredQuery, teams]);

  return {
    deferredQuery,
    query,
    setQuery,
    visibleTeams
  };
}
