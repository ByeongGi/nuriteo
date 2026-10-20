import { getCurrentWorkspaces } from "@nuriteo/api-client";
import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { EntryUnavailable } from "../../_components/entry-unavailable.tsx";
import {
  isExplicitlySignedOut,
  safeRequestReference
} from "../../../lib/api/presentation-error.ts";
import { createServerApiClient } from "../../../lib/api/server-client.ts";
import {
  resolveWorkspaceSelection,
  workspaceOwnerLabel
} from "../../../lib/workspace-selection.ts";

export const metadata: Metadata = {
  title: "워크스페이스"
};

interface WorkspacesPageProps {
  readonly searchParams: Promise<{
    invitation?: string | string[] | undefined;
    joined?: string | string[] | undefined;
    workspace?: string | string[] | undefined;
  }>;
}

export default async function WorkspacesPage({ searchParams }: WorkspacesPageProps) {
  const {
    invitation,
    joined,
    workspace: requestedScope
  } = await searchParams;
  const invitationStatus = joined === "1"
    ? "Organization invitation accepted. The shared Workspace is now available."
    : invitation === "declined"
      ? "Organization invitation declined. No Workspace access was added."
      : undefined;
  try {
    const client = await createServerApiClient();
    const result = await getCurrentWorkspaces(client);
    const workspaces = result.data.workspaces;
    const selectedScope = resolveWorkspaceSelection(workspaces, requestedScope);

    if (workspaces.length === 0) {
      return (
        <main id="main-content" className="workspace-page" tabIndex={-1}>
          <section className="workspace-empty" aria-labelledby="workspace-empty-title">
            <p className="eyebrow">사용 가능한 워크스페이스 없음</p>
            <h1 id="workspace-empty-title">관리자에게 접근 권한을 요청하세요</h1>
            <p>계정은 활성화되었지만 현재 사용할 수 있는 개인 또는 조직 워크스페이스가 없습니다.</p>
            <Link className="link-button" href="/workspaces">
              접근 권한 다시 확인
            </Link>
          </section>
        </main>
      );
    }
    const activeScope = selectedScope ?? workspaces[0]!.storageScopeId;

    return (
      <main id="main-content" className="workspace-page workspace-dashboard" tabIndex={-1}>
        <header className="workspace-dashboard__header">
          <div>
            <p className="eyebrow">NURITEO WORKSPACE</p>
            <h1>어떤 작업을 이어갈까요?</h1>
            <p>개인 작업과 조직 프로젝트를 한곳에서 선택하고 이어서 작업하세요.</p>
          </div>
          <Link className="link-button workspace-dashboard__primary" href={`/projects?workspace=${encodeURIComponent(activeScope)}`}>
            프로젝트 열기
          </Link>
        </header>

        {invitationStatus ? (
          <p className="form-status" role="status" aria-live="polite">
            {invitationStatus}
          </p>
        ) : null}

        <nav className="workspace-selector workspace-selector--dashboard" aria-labelledby="workspace-selector-title">
          <header>
            <div><h2 id="workspace-selector-title">워크스페이스</h2><p>작업할 공간을 선택하세요.</p></div>
            <span>{workspaces.length}개</span>
          </header>
          <ul>
            {workspaces.map((workspace) => {
              const isSelected = workspace.storageScopeId === activeScope;
              const ownerLabel = workspaceOwnerLabel(workspace);
              return (
                <li key={workspace.storageScopeId}>
                  <Link
                    className="workspace-option"
                    href={`/workspaces?workspace=${encodeURIComponent(workspace.storageScopeId)}`}
                    aria-current={isSelected ? "page" : undefined}
                  >
                    <span className="workspace-option__copy">
                      <strong>{workspace.displayLabel}</strong>
                      <span>{ownerLabel} 워크스페이스</span>
                    </span>
                    <span className="workspace-option__state" aria-hidden={!isSelected}>
                      {isSelected ? "현재 선택됨" : "선택"}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <section className="workspace-dashboard__shortcuts" aria-labelledby="workspace-shortcuts-title">
          <header><h2 id="workspace-shortcuts-title">빠른 이동</h2><p>자주 사용하는 관리 화면으로 이동합니다.</p></header>
          <div>
            <Link href={`/projects?workspace=${encodeURIComponent(activeScope)}`}><span>P</span><strong>프로젝트</strong><small>코드와 실행 환경 관리</small></Link>
            <Link href="/organizations"><span>O</span><strong>조직</strong><small>멤버와 팀 권한 관리</small></Link>
            <Link href="/notifications"><span>●</span><strong>알림</strong><small>최근 변경 사항 확인</small></Link>
          </div>
        </section>
      </main>
    );
  } catch (error) {
    if (isExplicitlySignedOut(error)) {
      redirect("/sign-in");
    }

    return (
      <EntryUnavailable
        description="NURITEO could not load your Workspaces. Retry when the Core service is available."
        reference={safeRequestReference(error)}
        retryHref="/workspaces"
        title="Workspaces are temporarily unavailable"
      />
    );
  }
}
