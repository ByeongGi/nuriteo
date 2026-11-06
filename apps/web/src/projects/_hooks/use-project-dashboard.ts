"use client";

import { useRouter } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { projectError, readCsrfCredential } from "@/lib/api/browser-security.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import {
  createProjectFormSchema,
  projectRoleGrantSchema,
  renameProjectFormSchema
} from "@/projects/_schema/project-dashboard.ts";
import {
  createProjectRoleDirectory,
  projectHref,
  projectRoleLabel,
  projectStudioHref,
  projectTemplateId,
  roleValue,
  upsertProject,
  visibleInState
} from "@/projects/_utils/project-dashboard.ts";
import type { OrganizationMemberOption } from "@/projects/_utils/project-dashboard.ts";
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
} from "@/services/projects/api.ts";

import type { FormEvent } from "react";
import type {
  DirectProjectRole,
  Project,
  ProjectCollection,
  ProjectListState,
  ProjectOwner,
  ProjectRole,
  Workspace
} from "@nuriteo/api-client";
import type { CollaborationOperation } from "@/lib/api/browser-security.ts";

const EMPTY_ORGANIZATION_MEMBERS: readonly OrganizationMemberOption[] = [];

export function useProjectDashboard(props: {
  readonly initialCollection?: ProjectCollection;
  readonly initialGrants?: readonly DirectProjectRole[];
  readonly initialProject?: Project;
  readonly initialProjectEtag?: string;
  readonly organizationMembers?: readonly OrganizationMemberOption[];
  readonly selectedScope?: string;
  readonly selectedState?: ProjectListState;
  readonly workspaces: readonly Workspace[];
}) {
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

  function rejectForm(message: string | undefined) {
    setError(message ?? "입력값을 확인하세요.");
    setNeedsReconciliation(false);
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (owner === undefined || workspace === undefined) return;
    const data = new FormData(event.currentTarget);
    const parsed = createProjectFormSchema.safeParse({
      name: String(data.get("name") ?? ""),
      slug: String(data.get("slug") ?? "")
    });
    if (!parsed.success) {
      rejectForm(parsed.error.issues[0]?.message);
      return;
    }
    await mutate("project-create", async () => {
      const result = await createProject(createBrowserApiClient(), {
        owner,
        slug: parsed.data.slug,
        name: parsed.data.name,
        templateId: projectTemplateId(data.get("templateId"))
      }, { csrfToken: readCsrfCredential() });
      router.replace(projectStudioHref(workspace.storageScopeId, result.data.id));
    });
  }

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (owner === undefined || project === undefined || etag === undefined) return;
    const parsed = renameProjectFormSchema.safeParse({
      name: String(new FormData(event.currentTarget).get("name") ?? "")
    });
    if (!parsed.success) {
      rejectForm(parsed.error.issues[0]?.message);
      return;
    }
    const name = parsed.data.name;
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
    const role = roleValue(data.get("role"));
    const parsed = projectRoleGrantSchema.safeParse({ userId: selectedMember.userId, role });
    if (!parsed.success) {
      setSelectedMemberId("");
      return;
    }
    const userId = parsed.data.userId;
    setRoleStatus(undefined);
    await mutate("project-role", async () => {
      const result = await grantDirectProjectRole(createBrowserApiClient(), { owner, projectId: project.id, etag, userId, role: parsed.data.role }, { csrfToken: readCsrfCredential() });
      if (result.data.grant !== null) setGrants((items) => [...items, result.data.grant!]);
      setSelectedMemberId("");
      setEtag(result.etag);
      setProject((current) => current === undefined ? current : { ...current, version: result.data.projectVersion });
      setRoleStatus(`${selectedMember.displayName} 멤버에게 ${projectRoleLabel(parsed.data.role)} 권한을 부여했습니다.`);
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

  return {
    addRole,
    changeLifecycle,
    confirmingProjectDelete,
    create,
    cursor,
    error,
    grantedUserIds,
    grants,
    hasAmbiguousMembers,
    hasAvailableMembers,
    hasUniqueMemberLabel,
    isLoadingMore,
    isSearchPending,
    loadMore,
    memberByUserId,
    mutation,
    needsReconciliation,
    normalizedProjectQuery,
    organizationMembers,
    owner,
    project,
    projectCountLabel,
    projectQuery,
    remove,
    rename,
    roleStatus,
    router,
    selectedMemberId,
    setConfirmingProjectDelete,
    setProjectQuery,
    setSelectedMemberId,
    state,
    updateRole,
    visibleProjects,
    workspace
  };
}
