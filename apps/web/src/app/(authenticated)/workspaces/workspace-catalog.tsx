"use client";

import type { Workspace } from "@nuriteo/api-client";
import Link from "next/link";
import { useMemo, useState } from "react";

import { SegmentedControl } from "#src/components/ui/segmented-control.tsx";
import { workspaceOwnerLabel } from "#src/lib/workspace-selection.ts";

type WorkspaceFilter = "all" | Workspace["ownerType"];

export function WorkspaceScreen({
  activeScope,
  invitationStatus,
  workspaces
}: Readonly<{
  activeScope: string;
  invitationStatus?: string | undefined;
  workspaces: readonly Workspace[];
}>) {
  return (
    <main id="main-content" className="workspace-page workspace-dashboard" tabIndex={-1}>
      <header className="workspace-dashboard__header product-page__header">
        <div>
          <p className="eyebrow">워크스페이스 선택</p>
          <h1>워크스페이스</h1>
          <p>개인 작업과 조직 작업을 구분하고, 필요한 개발 환경으로 이동하세요.</p>
        </div>
        <Link className="link-button workspace-dashboard__primary" href="/organizations">
          새 조직 만들기
        </Link>
      </header>

      {invitationStatus ? (
        <p className="form-status" role="status" aria-live="polite">
          {invitationStatus}
        </p>
      ) : null}

      <WorkspaceCatalog activeScope={activeScope} workspaces={workspaces} />
    </main>
  );
}

export function EmptyWorkspaceScreen() {
  return (
    <main id="main-content" className="workspace-page" tabIndex={-1}>
      <section className="workspace-empty" aria-labelledby="workspace-empty-title">
        <p className="eyebrow">시작할 작업 공간이 없습니다</p>
        <h1 id="workspace-empty-title">첫 워크스페이스를 준비하세요</h1>
        <p>조직을 만들거나, 초대받은 조직의 접근 권한을 다시 확인할 수 있습니다.</p>
        <div className="workspace-empty__actions">
          <Link className="link-button" href="/organizations">조직 만들기</Link>
          <Link className="link-button link-button--secondary" href="/workspaces">접근 권한 다시 확인</Link>
        </div>
      </section>
    </main>
  );
}

export function WorkspaceCatalog({ activeScope, workspaces }: Readonly<{
  activeScope: string;
  workspaces: readonly Workspace[];
}>) {
  const [filter, setFilter] = useState<WorkspaceFilter>("all");
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase("ko-KR");
  const filteredWorkspaces = useMemo(() => workspaces.filter((workspace) => (
    (filter === "all" || workspace.ownerType === filter)
    && (normalizedQuery === "" || workspace.displayLabel.toLocaleLowerCase("ko-KR").includes(normalizedQuery))
  )), [filter, normalizedQuery, workspaces]);
  const personalCount = workspaces.filter((workspace) => workspace.ownerType === "user").length;
  const organizationCount = workspaces.length - personalCount;

  return (
    <div className="product-page__body">
      <section className="product-metrics" aria-label="워크스페이스 지표">
        <article><span>접근 가능한 공간</span><strong>{workspaces.length}</strong><small>현재 계정에서 사용할 수 있음</small></article>
        <article><span>개인 워크스페이스</span><strong>{personalCount}</strong><small>나만 사용하는 개발 공간</small></article>
        <article><span>조직 워크스페이스</span><strong>{organizationCount}</strong><small>멤버와 권한을 공유하는 공간</small></article>
      </section>

      <section className="product-toolbar" aria-label="워크스페이스 검색 및 필터">
        <label className="product-search">
          <span aria-hidden="true">⌕</span>
          <span className="sr-only">워크스페이스 검색</span>
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="이름으로 검색" />
        </label>
        <SegmentedControl
          aria-label="워크스페이스 유형"
          value={filter}
          onValueChange={setFilter}
          options={[
            { value: "all", label: `전체 ${workspaces.length}` },
            { value: "user", label: `개인 ${personalCount}` },
            { value: "organization", label: `조직 ${organizationCount}` }
          ]}
        />
      </section>

      <section className="product-panel" aria-labelledby="workspace-list-title">
        <header><div><h2 id="workspace-list-title">내 워크스페이스</h2><p>접근 가능한 공간과 현재 컨텍스트입니다.</p></div><span>{filteredWorkspaces.length}개</span></header>
        {filteredWorkspaces.length === 0 ? (
          <div className="product-list-empty"><strong>검색 결과가 없습니다.</strong><span>다른 이름이나 유형을 선택해보세요.</span></div>
        ) : (
          <div className="product-data-rows">
            {filteredWorkspaces.map((workspace) => {
              const isSelected = workspace.storageScopeId === activeScope;
              return (
                <article className="product-data-row" key={workspace.storageScopeId}>
                  <div><strong>{workspace.displayLabel}</strong><span>{workspaceOwnerLabel(workspace)} 워크스페이스</span></div>
                  <span className={`product-status${isSelected ? " product-status--success" : ""}`}><i />{isSelected ? "사용 중" : "사용 가능"}</span>
                  <Link aria-current={isSelected ? "page" : undefined} className="product-row-action" href={`/projects?workspace=${encodeURIComponent(workspace.storageScopeId)}`}>프로젝트 열기</Link>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
