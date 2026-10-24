"use client";

import type { Team } from "@nuriteo/api-client";
import Link from "next/link";
import { useDeferredValue, useMemo, useState } from "react";

import { teamManagementStyles } from "#src/app/(workspace)/workspaces/[workspaceId]/teams/team-management.styles.ts";
import { WorkspaceSection } from "#src/app/(workspace)/workspaces/[workspaceId]/workspace-section.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { SearchField } from "#src/components/ui/search-field.tsx";

export function TeamDirectory({ canCreateTeam, organizationName, teams, workspaceId }: Readonly<{ canCreateTeam: boolean; organizationName: string; teams: readonly Team[]; workspaceId: string }>) {
  const styles = teamManagementStyles();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/teams`;
  const visibleTeams = useMemo(() => {
    const normalized = deferredQuery.trim().toLocaleLowerCase("ko-KR");
    return normalized === "" ? teams : teams.filter((team) => `${team.displayName} ${team.slug}`.toLocaleLowerCase("ko-KR").includes(normalized));
  }, [deferredQuery, teams]);
  return <WorkspaceSection eyebrow={organizationName} title="팀" description="워크스페이스의 팀을 조회하고 찾습니다." actions={canCreateTeam ? <Button size="sm" variant="primary" render={<Link href={`${base}/new`} />}>새 팀</Button> : undefined}>
    <div className={styles.toolbar()}><SearchField label="팀 검색" placeholder="팀 이름 또는 슬러그 검색" value={query} onChange={(event) => setQuery(event.currentTarget.value)} /></div>
    <p className={styles.summary()} role="status">전체 {teams.length}개 중 {visibleTeams.length}개</p>
    {visibleTeams.length === 0 ? <div className={styles.empty()}>{teams.length === 0 ? "사용 가능한 팀이 없습니다." : "검색 결과가 없습니다."}</div> : <ul className={styles.list()} aria-label="워크스페이스 팀" aria-busy={query !== deferredQuery}>{visibleTeams.map((team) => <li className={styles.row()} key={team.id}><div className={styles.identity()}><span className={styles.name()}>{team.displayName}</span><span className={styles.metadata()}>{team.slug}</span></div><Button size="sm" render={<Link href={`${base}/${encodeURIComponent(team.id)}`} />}>팀 열기</Button></li>)}</ul>}
  </WorkspaceSection>;
}
