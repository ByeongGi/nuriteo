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
  ProjectTemplateId,
  Workspace
} from "@nuriteo/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { tv } from "tailwind-variants";

import { buttonVariants } from "#src/components/ui/button.styles.ts";
import { Button } from "#src/components/ui/button.tsx";
import { CollapsibleContent, CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "#src/components/ui/collapsible.tsx";
import { ConfirmationDialog } from "#src/components/ui/confirmation-dialog.tsx";
import { SelectField, TextField } from "#src/components/ui/field.tsx";
import { PageHeader } from "#src/components/ui/page-header.tsx";
import { SearchField } from "#src/components/ui/search-field.tsx";
import { SettingsGroup, SettingsRow } from "#src/components/ui/settings-group.tsx";
import { projectError, readCsrfCredential } from "#src/lib/api/browser-security.ts";
import type { CollaborationOperation } from "#src/lib/api/browser-security.ts";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";
import { ProjectGitPanel } from "#src/projects/project-git-panel.tsx";
import type { ProjectGitState } from "#src/projects/project-git-panel.tsx";
import { ProjectTemplatePicker } from "#src/projects/project-template-picker.tsx";

const projectDashboardStyles = tv({
  slots: {
    root: "mx-auto w-full max-w-none px-6 py-6 pb-16 outline-none max-[48rem]:px-4 max-[48rem]:py-4",
    header: "",
    count: "inline-flex shrink-0 items-center rounded-full bg-subtle px-2 py-1 text-xs font-semibold whitespace-nowrap text-muted-foreground",
    layout: "mt-4 grid min-w-0 grid-cols-1 gap-4",
    sidebar: "grid min-w-0 content-start gap-4",
    createForm: "mx-auto grid w-full max-w-5xl gap-6 rounded-2xl border border-muted-border bg-surface p-[clamp(1.25rem,4vw,2rem)] shadow-xs",
    createHeading: "col-span-full grid content-start gap-1 [&_h2]:m-0 [&_h2]:text-base max-[48rem]:col-span-1",
    createFields: "grid grid-cols-2 gap-4 max-[40rem]:grid-cols-1",
    createFooter: "flex items-center justify-between gap-4 border-t border-muted-border pt-5 max-[40rem]:items-stretch max-[40rem]:flex-col [&_p]:m-0 [&_p]:max-w-lg [&_p]:text-xs [&_p]:leading-5 [&_p]:text-muted-foreground",
    createButton: "min-w-44 whitespace-nowrap max-[40rem]:w-full",
    toolbar: "flex items-center gap-2 rounded-lg border border-muted-border bg-surface p-2 max-[48rem]:items-stretch max-[48rem]:flex-col",
    search: "flex-1",
    filters: "flex shrink-0 gap-1 overflow-x-auto rounded-lg bg-subtle p-1",
    filter: "inline-flex min-h-9 items-center rounded-md px-3 text-xs font-semibold whitespace-nowrap text-muted-foreground no-underline hover:bg-hover hover:text-foreground aria-[current=page]:bg-surface aria-[current=page]:text-foreground aria-[current=page]:shadow-xs",
    panel: "overflow-hidden rounded-lg border border-muted-border bg-surface",
    empty: "grid min-h-48 place-content-center justify-items-center gap-2 text-muted-foreground [&_span]:text-sm",
    list: "m-0 grid list-none p-0",
    item: "grid grid-cols-[minmax(0,1fr)_auto] items-center border-b border-muted-border p-0 last:border-b-0 max-[48rem]:grid-cols-1",
    main: "grid min-h-14 min-w-0 grid-cols-[1.75rem_minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-2 text-foreground no-underline hover:bg-hover max-[48rem]:grid-cols-[1.75rem_minmax(0,1fr)_auto] max-[48rem]:px-3",
    initial: "grid size-7 place-items-center rounded-md bg-selected text-[var(--n-font-size-2xs)] font-semibold text-link",
    recordCopy: "grid min-w-0 gap-1 [&_strong]:truncate [&_small]:truncate [&_small]:text-xs [&_small]:text-muted-foreground",
    status: "inline-flex items-center gap-1 rounded-full bg-subtle px-2 py-1 text-xs font-semibold whitespace-nowrap text-muted-foreground [&_i]:size-1.5 [&_i]:rounded-full [&_i]:bg-current max-[48rem]:hidden",
    activeStatus: "bg-success-subtle text-success",
    rowAction: "inline-flex min-h-10 items-center rounded-lg border border-strong-border px-3 text-sm font-semibold whitespace-nowrap max-[48rem]:border-0 max-[48rem]:px-1",
    settings: "mr-3 inline-flex min-h-9 shrink-0 items-center rounded-md px-3 text-xs font-semibold whitespace-nowrap text-muted-foreground no-underline hover:bg-hover hover:text-foreground max-[48rem]:mx-3 max-[48rem]:mb-3 max-[48rem]:w-[calc(100%-1.5rem)] max-[48rem]:justify-center max-[48rem]:border max-[48rem]:border-muted-border",
    pagination: "flex items-center justify-between gap-4 rounded-xl border border-muted-border bg-surface px-4 py-3 max-[48rem]:items-stretch max-[48rem]:flex-col [&_p]:m-0 [&_p]:text-sm [&_p]:text-muted-foreground max-[48rem]:[&_button]:w-full",
    detail: "grid min-w-0 content-start gap-4 rounded-xl border border-muted-border bg-surface p-[clamp(1rem,3vw,2rem)] shadow-xs",
    detailHeader: "flex min-h-14 items-start justify-between gap-4 border-b border-muted-border pb-4 max-[48rem]:flex-col",
    detailIdentity: "flex min-w-0 items-start gap-3",
    detailBack: "grid size-10 shrink-0 place-items-center rounded-lg border border-strong-border text-xl leading-none text-foreground no-underline hover:bg-hover",
    detailCopy: "min-w-0 [&_h2]:m-0 [&_p]:m-0 [&_p:last-child]:mt-1 [&_p:last-child]:text-sm [&_p:last-child]:text-muted-foreground",
    detailActions: "flex flex-wrap items-center gap-2 max-[48rem]:w-full max-[48rem]:[&>*]:flex-1",
    profileForm: "grid gap-4",
    projectActions: "grid gap-4 border-t border-muted-border pt-5",
    dangerActions: "grid gap-4",
    feedback: "grid gap-3 rounded-lg border border-danger/25 bg-danger-subtle px-4 py-3 text-sm text-danger [&_p]:m-0",
    eyebrow: "m-0 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground",
    emptyDetail: "grid min-h-56 place-content-center justify-items-center gap-2 rounded-lg border border-dashed border-muted-border bg-subtle p-6 text-center [&_h2]:m-0 [&_p]:m-0 [&_p:last-child]:max-w-md [&_p:last-child]:text-sm [&_p:last-child]:text-muted-foreground",
    accessSection: "grid gap-4 border-t border-muted-border pt-5 [&_h3]:m-0",
    accessForm: "grid gap-4 rounded-lg border border-muted-border bg-subtle p-4 md:grid-cols-[minmax(12rem,1fr)_minmax(9rem,0.6fr)_auto] md:items-end [&_p]:md:col-span-full",
    grantList: "m-0 grid list-none gap-2 p-0 [&>li]:grid [&>li]:grid-cols-[minmax(0,1fr)_auto] [&>li]:items-center [&>li]:gap-3 [&>li]:rounded-lg [&>li]:border [&>li]:border-muted-border [&>li]:p-3 max-[48rem]:[&>li]:grid-cols-1 [&>li>div:first-child]:grid [&>li>div:first-child]:min-w-0 [&>li>div:first-child>span]:text-sm [&>li>div:first-child>span]:text-muted-foreground",
    grantActions: "flex flex-wrap items-end justify-end gap-2 max-[48rem]:justify-stretch max-[48rem]:[&>*]:flex-1",
    roleStatus: "m-0 rounded-md border border-success/25 bg-success-subtle px-3 py-2 text-sm text-success",
    accessHint: "m-0 rounded-md bg-subtle px-3 py-2 text-sm text-muted-foreground"
  },
  variants: {
    detailMode: {
      true: {
        root: "max-w-none py-5",
        layout: "mt-6",
        sidebar: "hidden"
      },
      false: {
        detail: "hidden"
      }
    },
    sectionPage: {
      true: {
        accessForm: "rounded-none border-0 border-b border-muted-border bg-transparent px-4 py-3",
        accessHint: "mx-4 my-3",
        accessSection: "gap-0 overflow-hidden rounded-lg border border-muted-border bg-surface pt-0 [&>h3]:border-b [&>h3]:border-muted-border [&>h3]:px-4 [&>h3]:py-3 [&>h3]:text-sm",
        detail: "gap-4 rounded-none border-0 bg-transparent p-0 shadow-none",
        detailHeader: "hidden",
        grantList: "gap-0 [&>li]:rounded-none [&>li]:border-x-0 [&>li]:border-b-0 [&>li]:px-4 [&>li]:py-3",
        roleStatus: "mx-4 mt-3"
      },
      false: {}
    }
  }
});

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
  readonly detailSection?: "access" | "all" | "danger" | "general";
  readonly view?: "collection" | "create";
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
  const [confirmingProjectDelete, setConfirmingProjectDelete] = useState(false);
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
  const detailSection = props.detailSection ?? "all";
  const styles = projectDashboardStyles({
    detailMode: project !== undefined,
    sectionPage: project !== undefined && detailSection !== "all"
  });
  const sectionCopy = projectSettingsCopy(detailSection);
  const view = props.view ?? "collection";

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
    setConfirmingProjectDelete(false);
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
        name: String(data.get("name") ?? ""),
        templateId: projectTemplateId(data.get("templateId"))
      }, { csrfToken: readCsrfCredential() });
      router.replace(projectStudioHref(workspace.storageScopeId, result.data.id));
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

  async function remove() {
    if (owner === undefined || project === undefined || etag === undefined || workspace === undefined) return;
    setConfirmingProjectDelete(false);
    await mutate("project-delete", async () => {
      await deleteProject(createBrowserApiClient(), { owner, projectId: project.id, etag, name: project.name }, { csrfToken: readCsrfCredential() });
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
        : items.map((item) => {
          if (item.userId === grant.userId) return (result.data.grant!);
          return (item);
        }));
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

  function directGrantList() {
    if (grants.length === 0) return (<p className={styles.accessHint()}>직접 부여된 역할이 없습니다. 팀 역할 또는 조직 기본 권한이 적용될 수 있습니다.</p>);
    return (<ul className={styles.grantList()}>{grants.map((grant, grantIndex) => { const member = memberByUserId.get(grant.userId); const memberIsActionable = member !== undefined && hasUniqueMemberLabel(member); const memberLabel = directGrantMemberLabel(grant, grantIndex, grants, memberByUserId, hasUniqueMemberLabel); 
      const memberRoleSuffix = member === undefined ? ("") : (` · 조직 ${organizationRoleLabel(member.role)}`);
      return <li key={grant.userId}><div><strong>{memberLabel}</strong><span>{projectRoleLabel(grant.role)}{memberRoleSuffix}</span></div><div className={styles.grantActions()}><SelectField label={`${memberLabel} 역할`} labelHidden density="compact" value={grant.role} disabled={mutation.isPending || !memberIsActionable} options={[{ value: "read", label: "읽기" }, { value: "write", label: "쓰기" }, { value: "admin", label: "관리" }]} onValueChange={(nextRole) => void updateRole(grant, roleValue(nextRole))} /><Button type="button" aria-label={`${memberLabel} 역할 제거`} disabled={mutation.isPending} onClick={() => void updateRole(grant)}>제거</Button></div></li>; })}</ul>);
  }
  function roleStatusNotice() {
    if (roleStatus === undefined) return (null);
    return (<p className={styles.roleStatus()} role="status" aria-live="polite">{roleStatus}</p>);
  }
  function availableMemberNotice() {
    if (hasAvailableMembers) return (null);
    return (<p>직접 역할을 부여할 수 있는 조직 멤버가 없습니다.</p>);
  }
  function ambiguousMemberNotice() {
    if (hasAmbiguousMembers) return (<p>표시 이름과 조직 역할이 같은 멤버는 이름을 구분한 뒤 직접 역할을 부여할 수 있습니다.</p>);
    return (null);
  }
  function roleManager() {
    if (props.canManageRoles) return (<><form className={styles.accessForm()} onSubmit={addRole}><SelectField label="조직 멤버" name="userId" required value={selectedMemberId} disabled={mutation.isPending || !hasAvailableMembers} placeholder="멤버 선택" options={organizationMembers.map((member) => ({ value: member.userId, label: organizationMemberLabel(member), disabled: member.role === "owner" || !hasUniqueMemberLabel(member) || grantedUserIds.has(member.userId) }))} onValueChange={setSelectedMemberId} />{ambiguousMemberNotice()}{availableMemberNotice()}<SelectField label="역할" name="role" defaultValue="read" disabled={mutation.isPending || !hasAvailableMembers} options={[{ value: "read", label: "읽기" }, { value: "write", label: "쓰기" }, { value: "admin", label: "관리" }]} /><Button type="submit" disabled={mutation.isPending || selectedMemberId === ""}>역할 부여</Button></form>{roleStatusNotice()}{directGrantList()}</>);
    return (<p className={styles.accessHint()}>조직 소유자만 프로젝트의 직접 역할을 확인하고 관리할 수 있습니다.</p>);
  }
  function directRoleSection() {
    if ((detailSection === "all" || detailSection === "access") && owner?.ownerType === "organization") return (<section className={styles.accessSection()}><h3>직접 역할</h3>{roleManager()}</section>);
    return (null);
  }
  function projectDetail() {
    if (project === undefined || workspace === undefined) return (<div className={styles.emptyDetail()}><p className={styles.eyebrow()}>프로젝트 선택</p><h2>프로젝트를 선택하세요</h2><p>왼쪽 목록에서 프로젝트를 선택하면 실행 환경과 접근 권한을 확인할 수 있습니다.</p></div>);
    const lifecycleSettingLabel = project.state === "active" ? "프로젝트 보관" : "프로젝트 복원";
    const nextLifecycleAction = project.state === "active" ? "archive" : "restore";
    const lifecycleSettingDescription = project.state === "active" ? "활성 목록과 Studio에서 숨기며 필요할 때 복원할 수 있습니다." : "프로젝트를 다시 활성 목록과 Studio에서 사용할 수 있게 합니다.";
    const lifecycleButtonLabel = project.state === "active" ? "보관" : "복원";
    const projectLifecycleLabel = project.state === "active" ? "활성" : "보관됨";
    const selectedProject = project;
    const selectedWorkspace = workspace;
    function dangerSettings() {
      if (detailSection !== "danger") return null;
      return (
        <SettingsGroup tone="danger" title="위험 영역" description="프로젝트 가용성과 데이터를 변경하는 작업입니다.">
          <SettingsRow title={lifecycleSettingLabel} description={lifecycleSettingDescription}>
            <Button type="button" disabled={mutation.isPending} onClick={() => void changeLifecycle(nextLifecycleAction)}>{lifecycleSettingLabel}</Button>
          </SettingsRow>
          <SettingsRow layout="stacked" title="프로젝트 영구 삭제" description="삭제한 프로젝트와 기록은 복구할 수 없습니다.">
            <Button type="button" variant="danger" disabled={mutation.isPending} onClick={() => setConfirmingProjectDelete(true)}>프로젝트 삭제</Button>
          </SettingsRow>
        </SettingsGroup>
      );
    }
    function lifecycleActions() {
      if (detailSection !== "all") return null;
      return <section className={styles.projectActions()}><h3>상태 관리</h3><Button type="button" disabled={mutation.isPending} onClick={() => void changeLifecycle(nextLifecycleAction)}>{lifecycleButtonLabel}</Button><p>보관하면 활성 목록에서 숨겨집니다. 삭제한 프로젝트는 복구할 수 없습니다.</p><Button type="button" variant="danger" disabled={mutation.isPending} onClick={() => setConfirmingProjectDelete(true)}>프로젝트 삭제</Button></section>;
    }
    function generalSettings() {
      if (detailSection !== "all" && detailSection !== "general") return null;
      return <CollapsibleRoot className="mt-1" defaultOpen><CollapsibleTrigger><span>프로젝트 관리</span><small>이름과 표시 정보</small></CollapsibleTrigger><CollapsiblePanel><CollapsibleContent className="grid gap-5"><form className={styles.profileForm()} onSubmit={rename} aria-busy={mutation.isPending}><div><h3>프로젝트 정보</h3><p>목록과 협업 화면에 표시되는 이름입니다.</p></div><TextField label="프로젝트 이름" name="name" defaultValue={selectedProject.name} required maxLength={200} disabled={mutation.isPending} /><Button type="submit" disabled={mutation.isPending}>이름 저장</Button></form>{lifecycleActions()}</CollapsibleContent></CollapsiblePanel></CollapsibleRoot>;
    }
    function gitPanel() {
      if (detailSection !== "all" || selectedProject.state !== "active") return null;
      return <ProjectGitPanel initialState={props.initialGitState} project={selectedProject} />;
    }
    function openStudioAction() {
      if (selectedProject.state !== "active") return null;
      return <Link className={buttonVariants({ variant: "primary" })} href={projectStudioHref(selectedWorkspace.storageScopeId, selectedProject.id)}>편집기 열기</Link>;
    }
    return (
      <>
        <header className={styles.detailHeader()}><div className={styles.detailIdentity()}><Link className={styles.detailBack()} href={projectHref(selectedWorkspace.storageScopeId, state)} aria-label="프로젝트 목록으로 돌아가기">‹</Link><div className={styles.detailCopy()}><p className={styles.eyebrow()}>{projectLifecycleLabel} · 버전 {selectedProject.version}</p><h2>{selectedProject.name}</h2><p>{selectedWorkspace.displayLabel} / {selectedProject.slug}</p></div></div><div className={styles.detailActions()}>{openStudioAction()}<Link className={buttonVariants({ variant: "secondary" })} href={`/workspaces/${encodeURIComponent(selectedWorkspace.storageScopeId)}/projects/${encodeURIComponent(selectedProject.id)}/settings/tokens`}>액세스 토큰</Link></div></header>
        {gitPanel()}
        {generalSettings()}
        {dangerSettings()}
        {directRoleSection()}
      </>
    );
  }
  const loadMoreLabel = isLoadingMore ? ("불러오는 중…") : ("프로젝트 더 불러오기");
  const loadMoreHint = normalizedProjectQuery === "" ? ("다음 프로젝트를 이어서 불러올 수 있습니다.") : ("검색은 현재 불러온 프로젝트에 적용됩니다. 더 불러오면 검색 범위가 넓어집니다.");
  function moreProjects() {
    if (cursor !== null) return (<div className={styles.pagination()}><p>{loadMoreHint}</p><Button type="button" onClick={() => void loadMore()} disabled={isLoadingMore}>{loadMoreLabel}</Button></div>);
    return (null);
  }
  function emptyProjectResults() {
    if (workspace === undefined) return null;
    if (visibleProjects.length === 0) return (<div className={styles.empty()}><strong>검색 결과가 없습니다.</strong><span>다른 이름이나 상태를 선택해보세요.</span></div>);
    return ((
                <ul className={styles.list()} aria-label="프로젝트">
                  {visibleProjects.map((item) => {
                    const projectRowAction = item.state === "active" ? ("편집기 열기") : ("보관 설정");
                    const projectRowStatus = item.state === "active" ? ("정상") : ("보관됨");
                    const projectRowStatusClass = item.state === "active" ? (styles.activeStatus()) : ("");
                    const projectRowHref = item.state === "active" ? (projectStudioHref(workspace.storageScopeId, item.id)) : (projectDetailHref(workspace.storageScopeId, state, item.id));
                    return (
                    <li className={styles.item()} key={item.id}>
                      <Link
                        className={styles.main()}
                        href={projectRowHref}
                      >
                        <b className={styles.initial()} aria-hidden="true">{projectInitial(item.name)}</b>
                        <span className={styles.recordCopy()}><strong>{item.name}</strong><small>{item.slug} · v{item.version}</small></span>
                        <em className={`${styles.status()} ${projectRowStatusClass}`}><i />{projectRowStatus}</em>
                        <span className={styles.rowAction()}>{projectRowAction}</span>
                      </Link>
                      <Link
                        className={styles.settings()}
                        href={projectDetailHref(workspace.storageScopeId, state, item.id)}
                        aria-label={`${item.name} 프로젝트 설정`}
                      >
                        설정
                      </Link>
                    </li>
                  );
                  })}
                </ul>
              ));
  }
  const projectSearchStatus = isSearchPending ? ("검색 결과를 갱신하는 중") : (`${visibleProjects.length}개 프로젝트 표시 중`);
  function projectCollection() {
    if (workspace === undefined || view !== "collection") return null;
    return (<><section className={styles.toolbar()} aria-label="프로젝트 검색 및 상태 필터">
              <SearchField className={styles.search()} density="compact" label="불러온 프로젝트 검색" autoComplete="off" value={projectQuery} onChange={(event) => setProjectQuery(event.currentTarget.value)} placeholder="불러온 프로젝트에서 검색" />
              <nav className={styles.filters()} aria-label="프로젝트 상태">
                {(["active", "archived", "all"] as const).map((filter) => {
                  const filterCurrent = state === filter ? ("page") : (undefined);
                  return (<Link className={styles.filter()} key={filter} href={projectHref(workspace.storageScopeId, filter)} aria-current={filterCurrent}>{projectStateLabel(filter)}</Link>);
                })}
              </nav>
            </section>
            <section className={styles.panel()} aria-busy={isSearchPending} aria-label="프로젝트 목록">
              <p className="sr-only" role="status" aria-live="polite">{projectSearchStatus}</p>
              {emptyProjectResults()}
            </section>
            {moreProjects()}</>);
  }
  function createProjectForm() {
    if (view === "create") return (<form className={styles.createForm()} onSubmit={create} aria-busy={mutation.isPending}>
              <div className={styles.createHeading()}><div><p className={styles.eyebrow()}>새로 만들기</p><h2>새 프로젝트</h2></div></div>
              <div className={styles.createFields()}>
                <TextField label="프로젝트 이름" name="name" placeholder="런타임 편집기" required maxLength={200} disabled={mutation.isPending} />
                <TextField label="슬러그" name="slug" placeholder="runtime-editor" required pattern="[a-z0-9](?:[a-z0-9\\-]{0,61}[a-z0-9])?" maxLength={63} disabled={mutation.isPending} />
              </div>
              <ProjectTemplatePicker disabled={mutation.isPending} />
              <div className={styles.createFooter()}><p>선택한 템플릿은 프로젝트의 실행 방식과 기본 파일 구성을 결정하며 생성 후에는 변경할 수 없습니다.</p><Button className={styles.createButton()} type="submit" variant="primary" disabled={mutation.isPending}>프로젝트 만들기</Button></div>
            </form>);
    return (null);
  }
  function reconciliationAction() {
    if (needsReconciliation) return (<Button type="button" variant="secondary" onClick={() => router.refresh()}>최신 프로젝트 불러오기</Button>);
    return (null);
  }
  function projectErrorNotice() {
    if (error) return (<p role="alert">{error}</p>);
    return (null);
  }
  function projectHeaderAction() {
    if (workspace === undefined) return null;
    if (view === "create") return (<Link className={buttonVariants({ variant: "secondary" })} href={projectHref(workspace.storageScopeId, state)}>목록으로</Link>);
    return (<div className="flex items-center gap-2"><span className={styles.count()}>{projectCountLabel}</span><Link className={buttonVariants({ variant: "primary" })} href={`/workspaces/${encodeURIComponent(workspace.storageScopeId)}/projects/new`}>새 프로젝트</Link></div>);
  }
  const projectPageDescription = view === "create" ? ("프로젝트 정보와 시작 템플릿을 정하면 즉시 Studio를 열어 개발을 시작합니다.") : ("프로젝트를 선택해 Studio를 열거나 별도 설정을 관리합니다.");
  const projectPageTitle = view === "create" ? ("새 프로젝트") : ("프로젝트");
  return (
    <main id="main-content" className={styles.root()} tabIndex={-1}>
      <PageHeader
        className={styles.header()}
        density="compact"
        eyebrow={project === undefined ? workspace?.displayLabel ?? "워크스페이스" : workspace?.displayLabel ?? "워크스페이스"}
        title={project === undefined ? projectPageTitle : sectionCopy.title}
        description={project === undefined
          ? projectPageDescription
          : `${project.name}의 ${sectionCopy.description}`}
        actions={project === undefined && workspace !== undefined
          ? projectHeaderAction()
          : undefined}
      />
      {error || needsReconciliation ? (
        <div className={styles.feedback()}>
          {projectErrorNotice()}
          {reconciliationAction()}
        </div>
      ) : null}
      {workspace === undefined ? <p>사용 가능한 워크스페이스가 없습니다. 관리자에게 접근 권한을 요청하세요.</p> : (
        <div className={styles.layout()}>
          <aside className={styles.sidebar()}>
            {createProjectForm()}
            {projectCollection()}
          </aside>
          <section className={styles.detail()}>
            {projectDetail()}
          </section>
        </div>
      )}
      {project === undefined ? null : (
        <ConfirmationDialog
          busy={mutation.isPending}
          confirmLabel="프로젝트 삭제"
          description={`${project.name} 프로젝트와 관련 기록을 영구 삭제합니다. 이 작업은 되돌릴 수 없습니다.`}
          open={confirmingProjectDelete}
          title="이 프로젝트를 삭제할까요?"
          onCancel={() => setConfirmingProjectDelete(false)}
          onConfirm={() => void remove()}
        />
      )}
    </main>
  );
}

function projectStateLabel(state: ProjectListState): string {
  if (state === "archived") return "보관됨";
  if (state === "all") return "전체";
  return "활성";
}

function projectSettingsCopy(section: NonNullable<ProjectDashboardProps["detailSection"]>): {
  readonly description: string;
  readonly title: string;
} {
  if (section === "general") return { title: "일반 설정", description: "이름과 기본 표시 정보를 관리합니다." };
  if (section === "access") return { title: "접근 권한", description: "조직 멤버에게 직접 부여한 역할을 관리합니다." };
  if (section === "danger") return { title: "위험 영역", description: "보관, 복원과 영구 삭제 작업을 관리합니다." };
  return { title: "프로젝트 설정", description: "이름, Git, 접근 권한과 보관 상태를 관리합니다." };
}

function projectInitial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "P";
}

function roleValue(value: FormDataEntryValue | null): ProjectRole {
  return value === "admin" || value === "write" ? value : "read";
}

function projectTemplateId(value: FormDataEntryValue | null): ProjectTemplateId {
  if (value === "vite-react" || value === "next-app") return value;
  throw new TypeError("프로젝트 시작 템플릿을 선택하세요.");
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

function projectHref(scope: string, state: ProjectListState): string {
  const query = new URLSearchParams({ state });
  return `/workspaces/${encodeURIComponent(scope)}?${query.toString()}`;
}

function projectDetailHref(scope: string, state: ProjectListState, projectId: string): string {
  return `/workspaces/${encodeURIComponent(scope)}/projects/${encodeURIComponent(projectId)}/settings/general?${new URLSearchParams({ state }).toString()}`;
}

function projectStudioHref(scope: string, projectId: string): string {
  return `/workspaces/${encodeURIComponent(scope)}/projects/${encodeURIComponent(projectId)}/studio`;
}

function visibleInState(project: Project, state: ProjectListState): boolean {
  return state === "all" || project.state === state;
}

function upsertProject(projects: readonly Project[], project: Project): readonly Project[] {
  return projects.some((item) => item.id === project.id)
    ? projects.map((item) => {
      if (item.id === project.id) return (project);
      return (item);
    })
    : [...projects, project];
}
