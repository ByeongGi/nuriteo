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
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { Button } from "../../../components/ui/button.tsx";
import { projectError, readCsrfCredential } from "../../../lib/api/browser-security.ts";
import type { CollaborationOperation } from "../../../lib/api/browser-security.ts";
import { createBrowserApiClient } from "../../../lib/api/browser-client.ts";
import { useExclusiveMutation } from "../../../lib/use-exclusive-mutation.ts";
import type { PreviewOriginConfiguration } from "../../../runtime/preview-origin-contract.ts";
import { ProjectIdeShell } from "./project-ide-shell.tsx";
import { ProjectGitPanel } from "./project-git-panel.tsx";

interface Props {
  readonly canManageRoles?: boolean;
  readonly initialCollection?: ProjectCollection;
  readonly initialGrants?: readonly DirectProjectRole[];
  readonly initialProject?: Project;
  readonly initialProjectEtag?: string;
  readonly organizationMembers?: readonly OrganizationMemberOption[];
  readonly previewConfiguration: PreviewOriginConfiguration;
  readonly runtimeAssetRevision?: string;
  readonly selectedScope?: string;
  readonly selectedState?: ProjectListState;
  readonly workspaces: readonly Workspace[];
}

interface OrganizationMemberOption {
  readonly userId: string;
  readonly displayName: string;
  readonly role: OrganizationRole;
}

export function ProjectDashboard(props: Props) {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [projects, setProjects] = useState<readonly Project[]>(props.initialCollection?.items ?? []);
  const [cursor, setCursor] = useState(props.initialCollection?.nextCursor ?? null);
  const [project, setProject] = useState(props.initialProject);
  const [etag, setEtag] = useState(props.initialProjectEtag);
  const [grants, setGrants] = useState<readonly DirectProjectRole[]>(props.initialGrants ?? []);
  const [selectedMemberId, setSelectedMemberId] = useState("");
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
  const grantedUserIds = new Set(grants.map((grant) => grant.userId));
  const memberLabelCounts = new Map<string, number>();
  for (const member of props.organizationMembers ?? []) {
    const label = organizationMemberLabel(member);
    memberLabelCounts.set(label, (memberLabelCounts.get(label) ?? 0) + 1);
  }
  const hasUniqueMemberLabel = (member: OrganizationMemberOption): boolean =>
    memberLabelCounts.get(organizationMemberLabel(member)) === 1;
  const hasAvailableMembers = props.organizationMembers?.some(
    (member) => member.role !== "owner" &&
      hasUniqueMemberLabel(member) &&
      !grantedUserIds.has(member.userId)
  ) ?? false;
  const hasAmbiguousMembers = props.organizationMembers?.some(
    (member) => member.role !== "owner" && !hasUniqueMemberLabel(member)
  ) ?? false;
  const memberByUserId = new Map(
    props.organizationMembers?.map((member) => [member.userId, member] as const)
  );

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
      router.replace(projectHref(workspace.storageScopeId, state, result.data.id));
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
      setError("Enter the exact Project name before deleting it.");
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
    const selectedMember = props.organizationMembers?.find(
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
      setRoleStatus(`${selectedMember.displayName} now has ${role} access.`);
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
        ? `${member?.displayName ?? "Unavailable Organization member"} no longer has a direct role.`
        : `${member?.displayName ?? "Organization member"} now has ${nextRole} access.`);
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
    <main id="main-content" className="workspace-page project-page" tabIndex={-1}>
      <header className="workspace-page__intro"><p className="eyebrow">Workspace development</p><h1>Projects</h1><p>Create, archive, and share browser development Projects.</p></header>
      <nav className="organization-tabs" aria-label="Project Workspaces">
        {props.workspaces.map((item) => <Link key={item.storageScopeId} href={projectHref(item.storageScopeId, "active")} aria-current={item.storageScopeId === props.selectedScope ? "page" : undefined}>{item.displayLabel}</Link>)}
      </nav>
      {workspace === undefined ? <p>No Workspace is available. Ask an administrator for access.</p> : (
        <div className="project-layout">
          <aside className="project-sidebar">
            <form className="collaboration-form" onSubmit={create} aria-busy={mutation.isPending}>
              <h2>Create Project</h2>
              <label className="field-group">Slug<input name="slug" required pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" maxLength={63} disabled={mutation.isPending} /></label>
              <label className="field-group">Name<input name="name" required maxLength={200} disabled={mutation.isPending} /></label>
              <Button type="submit" variant="primary" disabled={mutation.isPending}>Create Project</Button>
            </form>
            <nav className="project-filters" aria-label="Project state">
              {(["active", "archived", "all"] as const).map((filter) => <Link key={filter} href={projectHref(workspace.storageScopeId, filter)} aria-current={state === filter ? "page" : undefined}>{filter}</Link>)}
            </nav>
            <ul className="record-list" aria-label="Projects">
              {projects.map((item) => <li key={item.id}><Link href={projectHref(workspace.storageScopeId, state, item.id)} aria-current={project?.id === item.id ? "page" : undefined}><strong>{item.name}</strong><span>{item.slug} · {item.state}</span></Link></li>)}
            </ul>
            {cursor !== null ? <Button type="button" onClick={() => void loadMore()} disabled={isLoadingMore}>{isLoadingMore ? "Loading…" : "Load more"}</Button> : null}
          </aside>
          <section className="project-detail">
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            {needsReconciliation ? <Button type="button" onClick={() => router.refresh()}>Reload latest Project</Button> : null}
            {project === undefined ? <div className="workspace-empty"><h2>Select a Project</h2><p>Choose a Project to inspect its lifecycle and access.</p></div> : (
              <>
                <header><p className="eyebrow">{project.state} · version {project.version}</p><h2>{project.name}</h2><p>{project.slug}</p><Link href={`/access-tokens?projectId=${encodeURIComponent(project.id)}`}>Manage Project tokens</Link></header>
                <form className="collaboration-form" onSubmit={rename} aria-busy={mutation.isPending}><label className="field-group">Project name<input name="name" defaultValue={project.name} required maxLength={200} disabled={mutation.isPending} /></label><Button type="submit" disabled={mutation.isPending}>Save name</Button></form>
                <section className="project-actions"><h3>Lifecycle</h3><Button type="button" disabled={mutation.isPending} onClick={() => void changeLifecycle(project.state === "active" ? "archive" : "restore")}>{project.state === "active" ? "Archive" : "Restore"}</Button><p>Archive hides a Project from the active list. Delete is immediate and irreversible.</p><form onSubmit={remove}><label className="field-group">Type <strong>{project.name}</strong> to delete<input name="confirmName" required disabled={mutation.isPending} /></label><Button type="submit" variant="danger" disabled={mutation.isPending}>Delete Project</Button></form></section>
                <ProjectIdeShell
                  key={`${workspace.storageScopeId}:${project.id}:${project.state}`}
                  {...(props.runtimeAssetRevision === undefined ? {} : { assetRevision: props.runtimeAssetRevision })}
                  previewConfiguration={props.previewConfiguration}
                  project={project}
                  {...(etag === undefined ? {} : { projectEtag: etag })}
                  onProjectCommit={(result) => {
                    setEtag(result.projectEtag);
                    setProject((current) => current === undefined ? current : { ...current, version: result.projectVersion });
                    setProjects((items) => items.map((item) => item.id === project.id ? { ...item, version: result.projectVersion } : item));
                  }}
                  onProjectReload={() => router.refresh()}
                  workspaceScope={workspace.storageScopeId}
                />
                {project.state === "active" ? <ProjectGitPanel project={project} /> : null}
                {owner?.ownerType === "organization" ? <section><h3>Direct roles</h3>{props.canManageRoles ? <><form className="collaboration-form" onSubmit={addRole}><label className="field-group">Organization member<select aria-label="Organization member" name="userId" required value={selectedMemberId} disabled={mutation.isPending || !hasAvailableMembers} onChange={(event) => setSelectedMemberId(event.currentTarget.value)}><option value="">Select a member</option>{props.organizationMembers?.map((member) => <option key={member.userId} value={member.userId} disabled={member.role === "owner" || !hasUniqueMemberLabel(member) || grantedUserIds.has(member.userId)}>{organizationMemberLabel(member)}</option>)}</select></label>{hasAmbiguousMembers ? <p>Members with the same display name and Organization role cannot receive a direct role until their display names are distinct.</p> : null}{hasAvailableMembers ? null : <p>No Organization members are available for a direct role.</p>}<label className="field-group">Role<select name="role" disabled={mutation.isPending || !hasAvailableMembers}><option value="read">Read</option><option value="write">Write</option><option value="admin">Admin</option></select></label><Button type="submit" disabled={mutation.isPending || selectedMemberId === ""}>Grant role</Button></form>{roleStatus === undefined ? null : <p role="status" aria-live="polite">{roleStatus}</p>}<ul className="record-list">{grants.map((grant, grantIndex) => { const member = memberByUserId.get(grant.userId); const memberIsActionable = member !== undefined && hasUniqueMemberLabel(member); const memberLabel = directGrantMemberLabel(grant, grantIndex, grants, memberByUserId, hasUniqueMemberLabel); return <li key={grant.userId}><div><strong>{memberLabel}</strong><span>{grant.role}{member === undefined ? "" : ` · Organization ${member.role}`}</span></div><div className="record-actions"><select aria-label={`Role for ${memberLabel}`} value={grant.role} disabled={mutation.isPending || !memberIsActionable} onChange={(event) => void updateRole(grant, roleValue(event.currentTarget.value))}><option value="read">Read</option><option value="write">Write</option><option value="admin">Admin</option></select><Button type="button" aria-label={`Revoke ${memberLabel}`} disabled={mutation.isPending} onClick={() => void updateRole(grant)}>Revoke</Button></div></li>; })}</ul></> : <p>Only Organization Owners can inspect and manage direct Project roles.</p>}</section> : null}
              </>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

function roleValue(value: FormDataEntryValue | null): ProjectRole {
  return value === "admin" || value === "write" ? value : "read";
}

function organizationMemberLabel(member: OrganizationMemberOption): string {
  return `${member.displayName} · Organization ${member.role}`;
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
    ? "Unavailable Organization member"
    : `${organizationMemberLabel(member)} · Ambiguous member`;
  const belongsToSameGroup = (candidate: DirectProjectRole): boolean => {
    const candidateMember = memberByUserId.get(candidate.userId);
    return member === undefined
      ? candidateMember === undefined
      : candidateMember !== undefined && organizationMemberLabel(candidateMember) === organizationMemberLabel(member);
  };
  const ordinal = grants.slice(0, grantIndex + 1).filter(belongsToSameGroup).length;
  const total = grants.filter(belongsToSameGroup).length;
  return `${baseLabel} · Grant ${ordinal} of ${total}`;
}

function projectHref(scope: string, state: ProjectListState, projectId?: string): string {
  const query = new URLSearchParams({ workspace: scope, state });
  if (projectId !== undefined) query.set("project", projectId);
  return `/projects?${query.toString()}`;
}

function visibleInState(project: Project, state: ProjectListState): boolean {
  return state === "all" || project.state === state;
}

function upsertProject(projects: readonly Project[], project: Project): readonly Project[] {
  return projects.some((item) => item.id === project.id)
    ? projects.map((item) => item.id === project.id ? project : item)
    : [...projects, project];
}
