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

interface Props {
  readonly canManageRoles?: boolean;
  readonly initialCollection?: ProjectCollection;
  readonly initialGrants?: readonly DirectProjectRole[];
  readonly initialProject?: Project;
  readonly initialProjectEtag?: string;
  readonly selectedScope?: string;
  readonly selectedState?: ProjectListState;
  readonly workspaces: readonly Workspace[];
}

export function ProjectDashboard(props: Props) {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [projects, setProjects] = useState<readonly Project[]>(props.initialCollection?.items ?? []);
  const [cursor, setCursor] = useState(props.initialCollection?.nextCursor ?? null);
  const [project, setProject] = useState(props.initialProject);
  const [etag, setEtag] = useState(props.initialProjectEtag);
  const [grants, setGrants] = useState<readonly DirectProjectRole[]>(props.initialGrants ?? []);
  const [error, setError] = useState<string>();
  const [needsReconciliation, setNeedsReconciliation] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const paginationAbort = useRef<AbortController | undefined>(undefined);
  const workspace = props.workspaces.find((item) => item.storageScopeId === props.selectedScope);
  const owner: ProjectOwner | undefined = workspace === undefined
    ? undefined
    : { ownerType: workspace.ownerType, ownerId: workspace.ownerId };
  const state = props.selectedState ?? "active";

  useEffect(() => () => paginationAbort.current?.abort(), []);

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
    const userId = String(data.get("userId") ?? "");
    const role = roleValue(data.get("role"));
    await mutate("project-role", async () => {
      const result = await grantDirectProjectRole(createBrowserApiClient(), { owner, projectId: project.id, etag, userId, role }, { csrfToken: readCsrfCredential() });
      if (result.data.grant !== null) setGrants((items) => [...items, result.data.grant!]);
      setEtag(result.etag);
      setProject((current) => current === undefined ? current : { ...current, version: result.data.projectVersion });
    });
  }

  async function updateRole(grant: DirectProjectRole, nextRole?: ProjectRole) {
    if (owner?.ownerType !== "organization" || project === undefined || etag === undefined) return;
    await mutate("project-role", async () => {
      const result = nextRole === undefined
        ? await revokeDirectProjectRole(createBrowserApiClient(), { owner, projectId: project.id, etag, userId: grant.userId }, { csrfToken: readCsrfCredential() })
        : await changeDirectProjectRole(createBrowserApiClient(), { owner, projectId: project.id, etag, userId: grant.userId, role: nextRole }, { csrfToken: readCsrfCredential() });
      setGrants((items) => result.data.grant === null
        ? items.filter((item) => item.userId !== grant.userId)
        : items.map((item) => item.userId === grant.userId ? result.data.grant! : item));
      setEtag(result.etag);
      setProject((current) => current === undefined ? current : { ...current, version: result.data.projectVersion });
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
                <header><p className="eyebrow">{project.state} · version {project.version}</p><h2>{project.name}</h2><p>{project.slug}</p></header>
                <form className="collaboration-form" onSubmit={rename} aria-busy={mutation.isPending}><label className="field-group">Project name<input name="name" defaultValue={project.name} required maxLength={200} disabled={mutation.isPending} /></label><Button type="submit" disabled={mutation.isPending}>Save name</Button></form>
                <section className="project-actions"><h3>Lifecycle</h3><Button type="button" disabled={mutation.isPending} onClick={() => void changeLifecycle(project.state === "active" ? "archive" : "restore")}>{project.state === "active" ? "Archive" : "Restore"}</Button><p>Archive hides a Project from the active list. Delete is immediate and irreversible.</p><form onSubmit={remove}><label className="field-group">Type <strong>{project.name}</strong> to delete<input name="confirmName" required disabled={mutation.isPending} /></label><Button type="submit" variant="danger" disabled={mutation.isPending}>Delete Project</Button></form></section>
                <section className="project-placeholder"><h3>Runtime</h3><p>Runtime and preview controls will appear here after RT-002 is available.</p></section>
                {owner?.ownerType === "organization" ? <section><h3>Direct roles</h3>{props.canManageRoles ? <><form className="collaboration-form" onSubmit={addRole}><label className="field-group">Organization member user ID<input name="userId" required disabled={mutation.isPending} /></label><label className="field-group">Role<select name="role" disabled={mutation.isPending}><option value="read">Read</option><option value="write">Write</option><option value="admin">Admin</option></select></label><Button type="submit" disabled={mutation.isPending}>Grant role</Button></form><ul className="record-list">{grants.map((grant) => <li key={grant.userId}><div><strong>{grant.userId}</strong><span>{grant.role}</span></div><div className="record-actions"><select aria-label={`Role for ${grant.userId}`} value={grant.role} disabled={mutation.isPending} onChange={(event) => void updateRole(grant, roleValue(event.currentTarget.value))}><option value="read">Read</option><option value="write">Write</option><option value="admin">Admin</option></select><Button type="button" disabled={mutation.isPending} onClick={() => void updateRole(grant)}>Revoke</Button></div></li>)}</ul></> : <p>Only Organization Owners can inspect and manage direct Project roles.</p>}</section> : null}
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
