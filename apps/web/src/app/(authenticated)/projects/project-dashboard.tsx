"use client";

import {
  archiveProject,
  changeDirectProjectRole,
  createProject,
  deleteProject,
  grantDirectProjectRole,
  listProjects,
  renameProject,
  restoreProject,
  revokeDirectProjectRole
} from "@nuriteo/api-client";
import type {
  DirectProjectRole,
  OrganizationRole,
  Project,
  ProjectCollection,
  ProjectListState,
  ProjectOwner,
  ProjectRole,
  Workspace
} from "@nuriteo/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import { Button } from "#src/components/ui/button.tsx";
import { SelectField } from "#src/components/ui/field.tsx";
import { projectError, readCsrfCredential } from "#src/lib/api/browser-security.ts";
import type { CollaborationOperation } from "#src/lib/api/browser-security.ts";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";
import { ProjectGitPanel } from "#src/app/(authenticated)/projects/project-git-panel.tsx";
import type { ProjectGitState } from "#src/app/(authenticated)/projects/project-git-panel.tsx";

export interface ProjectDashboardProps {
  readonly canManageRoles?: boolean;
  readonly initialCollection?: ProjectCollection;
  readonly initialGitState?: ProjectGitState;
  readonly initialGrants?: readonly DirectProjectRole[];
  readonly initialProject?: Project;
  readonly initialProjectEtag?: string;
  readonly organizationMembers?: readonly OrganizationMemberOption[];
  readonly selectedScope?: string;
  readonly selectedState?: ProjectListState;
  readonly workspaces: readonly Workspace[];
}

interface OrganizationMemberOption {
  readonly userId: string;
  readonly displayName: string;
  readonly role: OrganizationRole;
}

const EMPTY_ORGANIZATION_MEMBERS: readonly OrganizationMemberOption[] = [];

export function ProjectDashboard(props: ProjectDashboardProps) {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [projects, setProjects] = useState<readonly Project[]>(props.initialCollection?.items ?? []);
  const [cursor, setCursor] = useState(props.initialCollection?.nextCursor ?? null);
  const [project, setProject] = useState(props.initialProject);
  const [etag, setEtag] = useState(props.initialProjectEtag);
  const [grants, setGrants] = useState<readonly DirectProjectRole[]>(props.initialGrants ?? []);
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const deferredProjectQuery = useDeferredValue(projectQuery);
  const [roleStatus, setRoleStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [needsReconciliation, setNeedsReconciliation] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const paginationAbort = useRef<AbortController | undefined>(undefined);
  const workspace = props.workspaces.find((item) => item.storageScopeId === props.selectedScope);
  const owner: ProjectOwner | undefined = workspace === undefined
    ? undefined
    : { ownerType: workspace.ownerType, ownerId: workspace.ownerId };
  const state = props.selectedState ?? "active";
  const normalizedProjectQuery = deferredProjectQuery.trim().toLocaleLowerCase("ko-KR");
  const visibleProjects = useMemo(() => normalizedProjectQuery === ""
    ? projects
    : projects.filter((item) => `${item.name} ${item.slug}`.toLocaleLowerCase("ko-KR").includes(normalizedProjectQuery)),
  [normalizedProjectQuery, projects]);
  const organizationMembers = props.organizationMembers ?? EMPTY_ORGANIZATION_MEMBERS;
  const {
    grantedUserIds,
    hasAmbiguousMembers,
    hasAvailableMembers,
    hasUniqueMemberLabel,
    memberByUserId
  } = useMemo(
    () => createProjectRoleDirectory(organizationMembers, grants),
    [grants, organizationMembers]
  );
  const isSearchPending = projectQuery !== deferredProjectQuery;
  const projectCountLabel = cursor === null
    ? `${projects.length}개 프로젝트`
    : `${projects.length}개 이상 프로젝트`;

  useEffect(() => () => paginationAbort.current?.abort(), []);
  useEffect(() => {
    setProjects(props.initialCollection?.items ?? []);
    setCursor(props.initialCollection?.nextCursor ?? null);
    setProject(props.initialProject);
    setEtag(props.initialProjectEtag);
    setGrants(props.initialGrants ?? []);
    setSelectedMemberId("");
    setRoleStatus(undefined);
    setNeedsReconciliation(false);
  }, [props.initialCollection, props.initialGrants, props.initialProject, props.initialProjectEtag]);

  async function mutate(operation: CollaborationOperation, action: () => Promise<void>) {
    await mutation.run(async () => {
      setError(undefined);
      setNeedsReconciliation(false);
      try {
        await action();
      } catch (cause) {
        const failure = projectError(cause, operation);
        setError(failure.message);
        setNeedsReconciliation(failure.reconcile);
      }
    });
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (owner === undefined || workspace === undefined) return;
    const data = new FormData(event.currentTarget);
    await mutate("project-create", async () => {
      const result = await createProject(createBrowserApiClient(), {
        owner,
        slug: String(data.get("slug") ?? ""),
        name: String(data.get("name") ?? "")
      }, { csrfToken: readCsrfCredential() });
      router.replace(projectDetailHref(workspace.storageScopeId, state, result.data.id));
    });
  }

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (owner === undefined || project === undefined || etag === undefined) return;
    const name = String(new FormData(event.currentTarget).get("name") ?? "");
    await mutate("project-profile", async () => {
      const result = await renameProject(createBrowserApiClient(), {
        owner, projectId: project.id, etag, name
      }, { csrfToken: readCsrfCredential() });
      setProject(result.data);
      setEtag(result.etag);
      setProjects((items) => items.map((item) => item.id === result.data.id ? result.data : item));
    });
  }

  async function changeLifecycle(action: "archive" | "restore") {
    if (owner === undefined || project === undefined || etag === undefined) return;
    await mutate("project-lifecycle", async () => {
      const result = await (action === "archive" ? archiveProject : restoreProject)(
        createBrowserApiClient(),
        { owner, projectId: project.id, etag },
        { csrfToken: readCsrfCredential() }
      );
      setProject(result.data);
      setEtag(result.etag);
      setProjects((items) => visibleInState(result.data, state)
        ? upsertProject(items, result.data)
        : items.filter((item) => item.id !== result.data.id));
    });
  }

  async function remove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (owner === undefined || project === undefined || etag === undefined || workspace === undefined) return;
    const name = String(new FormData(event.currentTarget).get("confirmName") ?? "");
    if (name !== project.name) {
      setError("프로젝트를 삭제하려면 정확한 프로젝트 이름을 입력하세요.");
      return;
    }
    await mutate("project-delete", async () => {
      await deleteProject(createBrowserApiClient(), { owner, projectId: project.id, etag, name }, { csrfToken: readCsrfCredential() });
      router.replace(projectHref(workspace.storageScopeId, state));
    });
  }

  async function addRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (owner?.ownerType !== "organization" || project === undefined || etag === undefined) return;
    const data = new FormData(event.currentTarget);
    const selectedMember = organizationMembers.find(
      (member) => member.userId === selectedMemberId
    );
    if (selectedMember === undefined || selectedMember.role === "owner" ||
      !hasUniqueMemberLabel(selectedMember) || grantedUserIds.has(selectedMember.userId)) {
      setSelectedMemberId("");
      return;
    }
    const userId = selectedMember.userId;
    const role = roleValue(data.get("role"));
    setRoleStatus(undefined);
    await mutate("project-role", async () => {
      const result = await grantDirectProjectRole(createBrowserApiClient(), { owner, projectId: project.id, etag, userId, role }, { csrfToken: readCsrfCredential() });
      if (result.data.grant !== null) setGrants((items) => [...items, result.data.grant!]);
      setSelectedMemberId("");
      setEtag(result.etag);
      setProject((current) => current === undefined ? current : { ...current, version: result.data.projectVersion });
      setRoleStatus(`${selectedMember.displayName} 멤버에게 ${projectRoleLabel(role)} 권한을 부여했습니다.`);
    });
  }

  async function updateRole(grant: DirectProjectRole, nextRole?: ProjectRole) {
    if (owner?.ownerType !== "organization" || project === undefined || etag === undefined) return;
    const member = memberByUserId.get(grant.userId);
    const memberIsActionable = member !== undefined && hasUniqueMemberLabel(member);
    if (nextRole !== undefined && !memberIsActionable) return;
    setRoleStatus(undefined);
    await mutate("project-role", async () => {
      const result = nextRole === undefined
        ? await revokeDirectProjectRole(createBrowserApiClient(), { owner, projectId: project.id, etag, userId: grant.userId }, { csrfToken: readCsrfCredential() })
        : await changeDirectProjectRole(createBrowserApiClient(), { owner, projectId: project.id, etag, userId: grant.userId, role: nextRole }, { csrfToken: readCsrfCredential() });
      setGrants((items) => result.data.grant === null
        ? items.filter((item) => item.userId !== grant.userId)
        : items.map((item) => item.userId === grant.userId ? result.data.grant! : item));
      setEtag(result.etag);
      setProject((current) => current === undefined ? current : { ...current, version: result.data.projectVersion });
      setRoleStatus(nextRole === undefined
        ? `${member?.displayName ?? "확인할 수 없는 조직 멤버"} 멤버의 직접 역할을 제거했습니다.`
        : `${member?.displayName ?? "조직 멤버"} 멤버에게 ${projectRoleLabel(nextRole)} 권한을 부여했습니다.`);
    });
  }

  async function loadMore() {
    if (owner === undefined || cursor === null || isLoadingMore) return;
    paginationAbort.current?.abort();
    const controller = new AbortController();
    paginationAbort.current = controller;
    setIsLoadingMore(true);
    setError(undefined);
    try {
      const result = await listProjects(createBrowserApiClient(), { owner, state, pageSize: 50, cursor }, { signal: controller.signal });
      setProjects((items) => [...items, ...result.data.items]);
      setCursor(result.data.nextCursor);
    } catch (cause) {
      setError(projectError(cause, "project-profile").message);
    } finally {
      if (paginationAbort.current === controller) paginationAbort.current = undefined;
      setIsLoadingMore(false);
    }
  }

  return (
    <main id="main-content" className={`workspace-page project-page${project === undefined ? "" : " project-page--detail"}`} tabIndex={-1}>
      <header className="workspace-page__intro project-page__header"><div><p className="eyebrow">워크스페이스 개발</p><h1>프로젝트</h1><p>브라우저 개발 프로젝트를 만들고 실행 환경과 접근 권한을 관리합니다.</p></div><span>{projectCountLabel}</span></header>
      <nav className="organization-tabs" aria-label="프로젝트 워크스페이스">
        {props.workspaces.map((item) => <Link key={item.storageScopeId} href={projectHref(item.storageScopeId, "active")} aria-current={item.storageScopeId === props.selectedScope ? "page" : undefined}>{item.displayLabel}</Link>)}
      </nav>
      {workspace === undefined ? <p>사용 가능한 워크스페이스가 없습니다. 관리자에게 접근 권한을 요청하세요.</p> : (
        <div className={`project-layout ${project === undefined ? "project-layout--catalog" : "project-layout--detail"}`}>
          <aside className="project-sidebar">
            <form className="collaboration-form" onSubmit={create} aria-busy={mutation.isPending}>
              <div className="project-sidebar__heading"><div><p className="eyebrow">새로 만들기</p><h2>새 프로젝트</h2></div></div>
              <label className="field-group">슬러그<input name="slug" placeholder="runtime-editor" required pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" maxLength={63} disabled={mutation.isPending} /></label>
              <label className="field-group">프로젝트 이름<input name="name" placeholder="런타임 편집기" required maxLength={200} disabled={mutation.isPending} /></label>
              <Button type="submit" variant="primary" disabled={mutation.isPending}>프로젝트 만들기</Button>
            </form>
            <section className="product-toolbar project-catalog__toolbar" aria-label="프로젝트 검색 및 상태 필터">
              <label className="product-search"><span aria-hidden="true">⌕</span><span className="sr-only">불러온 프로젝트 검색</span><input type="search" autoComplete="off" value={projectQuery} onChange={(event) => setProjectQuery(event.currentTarget.value)} placeholder="불러온 프로젝트에서 검색" /></label>
              <nav className="project-filters product-segments" aria-label="프로젝트 상태">
                {(["active", "archived", "all"] as const).map((filter) => <Link key={filter} href={projectHref(workspace.storageScopeId, filter)} aria-current={state === filter ? "page" : undefined}>{projectStateLabel(filter)}</Link>)}
              </nav>
            </section>
            <section className="product-panel project-catalog__list" aria-busy={isSearchPending} aria-labelledby="project-list-title">
              <header><div><h2 id="project-list-title">프로젝트 목록</h2><p>프로젝트를 선택해 개요, Git, 권한을 확인하세요.</p></div><span>{visibleProjects.length}개 표시</span></header>
              <p className="sr-only" role="status" aria-live="polite">{isSearchPending ? "검색 결과를 갱신하는 중" : `${visibleProjects.length}개 프로젝트 표시 중`}</p>
              {visibleProjects.length === 0 ? <div className="product-list-empty"><strong>검색 결과가 없습니다.</strong><span>다른 이름이나 상태를 선택해보세요.</span></div> : (
                <ul className="record-list project-records" aria-label="프로젝트">
                  {visibleProjects.map((item) => <li key={item.id}><Link className="project-record-link" href={projectDetailHref(workspace.storageScopeId, state, item.id)} aria-current={project?.id === item.id ? "page" : undefined}><b aria-hidden="true">{projectInitial(item.name)}</b><span><strong>{item.name}</strong><small>{item.slug} · v{item.version}</small></span><em className={`product-status${item.state === "active" ? " product-status--success" : ""}`}><i />{item.state === "active" ? "정상" : "보관됨"}</em><span className="product-row-action">프로젝트 보기</span></Link></li>)}
                </ul>
              )}
            </section>
            {cursor !== null ? <div className="project-catalog__pagination"><p>{normalizedProjectQuery === "" ? "다음 프로젝트를 이어서 불러올 수 있습니다." : "검색은 현재 불러온 프로젝트에 적용됩니다. 더 불러오면 검색 범위가 넓어집니다."}</p><Button type="button" onClick={() => void loadMore()} disabled={isLoadingMore}>{isLoadingMore ? "불러오는 중…" : "프로젝트 더 불러오기"}</Button></div> : null}
          </aside>
          <section className="project-detail">
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            {needsReconciliation ? <Button type="button" onClick={() => router.refresh()}>최신 프로젝트 불러오기</Button> : null}
            {project === undefined ? <div className="workspace-empty"><p className="eyebrow">프로젝트 선택</p><h2>프로젝트를 선택하세요</h2><p>왼쪽 목록에서 프로젝트를 선택하면 실행 환경과 접근 권한을 확인할 수 있습니다.</p></div> : (
              <>
                <header className="project-detail__header"><div className="project-detail__identity"><Link className="project-detail__back" href={projectHref(workspace.storageScopeId, state)} aria-label="프로젝트 목록으로 돌아가기">‹</Link><div><p className="eyebrow">{project.state === "active" ? "활성" : "보관됨"} · 버전 {project.version}</p><h2>{project.name}</h2><p>{workspace.displayLabel} / {project.slug}</p></div></div><div className="project-detail__actions">{project.state === "active" ? <Link className="link-button link-button--primary" href={projectStudioHref(workspace.storageScopeId, project.id)}>Studio 열기</Link> : null}<Link className="link-button" href={`/access-tokens?projectId=${encodeURIComponent(project.id)}`}>액세스 토큰</Link></div></header>
                {project.state === "active" ? <ProjectGitPanel initialState={props.initialGitState} project={project} /> : null}
                <details className="project-management" open><summary><span>프로젝트 관리</span><small>이름, 보관 및 삭제</small></summary><div className="project-management__content"><form className="collaboration-form project-profile-form" onSubmit={rename} aria-busy={mutation.isPending}><div><h3>프로젝트 정보</h3><p>목록과 협업 화면에 표시되는 이름입니다.</p></div><label className="field-group">프로젝트 이름<input name="name" defaultValue={project.name} required maxLength={200} disabled={mutation.isPending} /></label><Button type="submit" disabled={mutation.isPending}>이름 저장</Button></form><section className="project-actions"><h3>상태 관리</h3><Button type="button" disabled={mutation.isPending} onClick={() => void changeLifecycle(project.state === "active" ? "archive" : "restore")}>{project.state === "active" ? "보관" : "복원"}</Button><p>보관하면 활성 목록에서 숨겨집니다. 삭제한 프로젝트는 복구할 수 없습니다.</p><form onSubmit={remove}><label className="field-group">삭제하려면 <strong>{project.name}</strong> 입력<input name="confirmName" required disabled={mutation.isPending} /></label><Button type="submit" variant="danger" disabled={mutation.isPending}>프로젝트 삭제</Button></form></section></div></details>
                {owner?.ownerType === "organization" ? <section><h3>직접 역할</h3>{props.canManageRoles ? <><form className="collaboration-form" onSubmit={addRole}><SelectField label="조직 멤버" name="userId" required value={selectedMemberId} disabled={mutation.isPending || !hasAvailableMembers} placeholder="멤버 선택" options={organizationMembers.map((member) => ({ value: member.userId, label: organizationMemberLabel(member), disabled: member.role === "owner" || !hasUniqueMemberLabel(member) || grantedUserIds.has(member.userId) }))} onValueChange={setSelectedMemberId} />{hasAmbiguousMembers ? <p>표시 이름과 조직 역할이 같은 멤버는 이름을 구분한 뒤 직접 역할을 부여할 수 있습니다.</p> : null}{hasAvailableMembers ? null : <p>직접 역할을 부여할 수 있는 조직 멤버가 없습니다.</p>}<SelectField label="역할" name="role" defaultValue="read" disabled={mutation.isPending || !hasAvailableMembers} options={[{ value: "read", label: "읽기" }, { value: "write", label: "쓰기" }, { value: "admin", label: "관리" }]} /><Button type="submit" disabled={mutation.isPending || selectedMemberId === ""}>역할 부여</Button></form>{roleStatus === undefined ? null : <p role="status" aria-live="polite">{roleStatus}</p>}<ul className="record-list">{grants.map((grant, grantIndex) => { const member = memberByUserId.get(grant.userId); const memberIsActionable = member !== undefined && hasUniqueMemberLabel(member); const memberLabel = directGrantMemberLabel(grant, grantIndex, grants, memberByUserId, hasUniqueMemberLabel); return <li key={grant.userId}><div><strong>{memberLabel}</strong><span>{projectRoleLabel(grant.role)}{member === undefined ? "" : ` · 조직 ${organizationRoleLabel(member.role)}`}</span></div><div className="record-actions"><SelectField label={`${memberLabel} 역할`} labelHidden density="compact" value={grant.role} disabled={mutation.isPending || !memberIsActionable} options={[{ value: "read", label: "읽기" }, { value: "write", label: "쓰기" }, { value: "admin", label: "관리" }]} onValueChange={(nextRole) => void updateRole(grant, roleValue(nextRole))} /><Button type="button" aria-label={`${memberLabel} 역할 제거`} disabled={mutation.isPending} onClick={() => void updateRole(grant)}>제거</Button></div></li>; })}</ul></> : <p>조직 소유자만 프로젝트의 직접 역할을 확인하고 관리할 수 있습니다.</p>}</section> : null}
              </>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

function projectStateLabel(state: ProjectListState): string {
  if (state === "archived") return "보관됨";
  if (state === "all") return "전체";
  return "활성";
}

function projectInitial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "P";
}

function roleValue(value: FormDataEntryValue | null): ProjectRole {
  return value === "admin" || value === "write" ? value : "read";
}

function organizationMemberLabel(member: OrganizationMemberOption): string {
  return `${member.displayName} · 조직 ${organizationRoleLabel(member.role)}`;
}

function createProjectRoleDirectory(
  members: readonly OrganizationMemberOption[],
  grants: readonly DirectProjectRole[]
) {
  const grantedUserIds = new Set(grants.map((grant) => grant.userId));
  const memberByUserId = new Map<string, OrganizationMemberOption>();
  const memberLabelCounts = new Map<string, number>();

  for (const member of members) {
    memberByUserId.set(member.userId, member);
    const label = organizationMemberLabel(member);
    memberLabelCounts.set(label, (memberLabelCounts.get(label) ?? 0) + 1);
  }

  const hasUniqueMemberLabel = (member: OrganizationMemberOption): boolean =>
    memberLabelCounts.get(organizationMemberLabel(member)) === 1;
  let hasAvailableMembers = false;
  let hasAmbiguousMembers = false;

  for (const member of members) {
    if (member.role === "owner") continue;
    const hasUniqueLabel = hasUniqueMemberLabel(member);
    if (!hasUniqueLabel) hasAmbiguousMembers = true;
    if (hasUniqueLabel && !grantedUserIds.has(member.userId)) hasAvailableMembers = true;
  }

  return {
    grantedUserIds,
    hasAmbiguousMembers,
    hasAvailableMembers,
    hasUniqueMemberLabel,
    memberByUserId
  };
}

function directGrantMemberLabel(
  grant: DirectProjectRole,
  grantIndex: number,
  grants: readonly DirectProjectRole[],
  memberByUserId: ReadonlyMap<string, OrganizationMemberOption>,
  hasUniqueMemberLabel: (member: OrganizationMemberOption) => boolean
): string {
  const member = memberByUserId.get(grant.userId);
  if (member !== undefined && hasUniqueMemberLabel(member)) return organizationMemberLabel(member);
  const baseLabel = member === undefined
    ? "확인할 수 없는 조직 멤버"
    : `${organizationMemberLabel(member)} · 이름 중복`;
  const belongsToSameGroup = (candidate: DirectProjectRole): boolean => {
    const candidateMember = memberByUserId.get(candidate.userId);
    return member === undefined
      ? candidateMember === undefined
      : candidateMember !== undefined && organizationMemberLabel(candidateMember) === organizationMemberLabel(member);
  };
  const ordinal = grants.slice(0, grantIndex + 1).filter(belongsToSameGroup).length;
  const total = grants.filter(belongsToSameGroup).length;
  return `${baseLabel} · 역할 ${ordinal}/${total}`;
}

function organizationRoleLabel(role: OrganizationRole): string {
  return role === "owner" ? "소유자" : "멤버";
}

function projectRoleLabel(role: ProjectRole): string {
  if (role === "admin") return "관리";
  if (role === "write") return "쓰기";
  return "읽기";
}

function projectHref(scope: string, state: ProjectListState, projectId?: string): string {
  const query = new URLSearchParams({ workspace: scope, state });
  if (projectId !== undefined) query.set("project", projectId);
  return `/projects?${query.toString()}`;
}

function projectDetailHref(scope: string, state: ProjectListState, projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}?${new URLSearchParams({ workspace: scope, state }).toString()}`;
}

function projectStudioHref(scope: string, projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/studio?${new URLSearchParams({ workspace: scope }).toString()}`;
}

function visibleInState(project: Project, state: ProjectListState): boolean {
  return state === "all" || project.state === state;
}

function upsertProject(projects: readonly Project[], project: Project): readonly Project[] {
  return projects.some((item) => item.id === project.id)
    ? projects.map((item) => item.id === project.id ? project : item)
    : [...projects, project];
}
