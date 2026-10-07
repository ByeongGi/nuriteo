"use client";

import {
  ApiError,
  addTeamMember,
  addTeamProjectRole,
  changeTeamMemberRole,
  changeTeamProjectRole,
  createTeam,
  deleteTeam,
  removeTeamMember,
  removeTeamProjectRole,
  renameTeam
} from "@nuriteo/api-client";
import type {
  Organization,
  ProjectRole,
  Team,
  TeamMember,
  TeamProjectRole,
  TeamRole
} from "@nuriteo/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import { Button } from "../../../../../components/ui/button.tsx";
import { readCsrfCredential } from "../../../../../lib/api/browser-security.ts";
import { createBrowserApiClient } from "../../../../../lib/api/browser-client.ts";
import { useExclusiveMutation } from "../../../../../lib/use-exclusive-mutation.ts";

interface OrganizationMemberOption {
  readonly displayName: string;
  readonly organizationRole: "owner" | "member";
  readonly userId: string;
}

interface ProjectOption {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

interface TeamConsoleProps {
  readonly canCreateTeam: boolean;
  readonly canDeleteTeam: boolean;
  readonly canManageMembers: boolean;
  readonly canManageProjectRoles: boolean;
  readonly canRenameTeam: boolean;
  readonly currentUserId: string;
  readonly initialMembers: readonly TeamMember[];
  readonly initialProjectRoles: readonly TeamProjectRole[];
  readonly organization: Organization;
  readonly organizationMembers: readonly OrganizationMemberOption[];
  readonly projects: readonly ProjectOption[];
  readonly selectedTeam?: Team;
  readonly selectedTeamEtag?: string;
  readonly teams: readonly Team[];
}

interface Feedback {
  readonly message: string;
  readonly reconcile: boolean;
  readonly tone: "error" | "success";
}

export function TeamConsole(props: TeamConsoleProps) {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [teams, setTeams] = useState(props.teams);
  const [team, setTeam] = useState(props.selectedTeam);
  const [teamEtag, setTeamEtag] = useState(props.selectedTeamEtag);
  const [members, setMembers] = useState(props.initialMembers);
  const [projectRoles, setProjectRoles] = useState(props.initialProjectRoles);
  const [feedback, setFeedback] = useState<Feedback>();
  const [deleteConfirmation, setDeleteConfirmation] = useState("");

  useEffect(() => {
    setTeams(props.teams);
    setTeam(props.selectedTeam);
    setTeamEtag(props.selectedTeamEtag);
    setMembers(props.initialMembers);
    setProjectRoles(props.initialProjectRoles);
    setFeedback(undefined);
    setDeleteConfirmation("");
  }, [
    props.initialMembers,
    props.initialProjectRoles,
    props.selectedTeam,
    props.selectedTeamEtag,
    props.teams
  ]);

  const memberOptions = useMemo(
    () => availableMemberOptions(props.organizationMembers, members),
    [members, props.organizationMembers]
  );
  const projectOptions = useMemo(
    () => props.projects.filter(
      (project) => !projectRoles.some((grant) => grant.projectId === project.id)
    ),
    [projectRoles, props.projects]
  );
  const memberById = useMemo(
    () => new Map(props.organizationMembers.map((member) => [member.userId, member] as const)),
    [props.organizationMembers]
  );
  const projectById = useMemo(
    () => new Map(props.projects.map((project) => [project.id, project] as const)),
    [props.projects]
  );

  async function runMutation(action: () => Promise<void>) {
    await mutation.run(async () => {
      setFeedback(undefined);
      try {
        await action();
      } catch (cause) {
        setFeedback(teamFailure(cause));
      }
    });
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await runMutation(async () => {
      const result = await createTeam(createBrowserApiClient(), {
        organizationId: props.organization.id,
        slug: String(data.get("slug") ?? ""),
        displayName: String(data.get("displayName") ?? "")
      }, { csrfToken: readCsrfCredential() });
      router.replace(teamHref(props.organization.id, result.data.id));
    });
  }

  async function handleRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (team === undefined || teamEtag === undefined) return;
    const displayName = String(new FormData(event.currentTarget).get("displayName") ?? "");
    await runMutation(async () => {
      const result = await renameTeam(createBrowserApiClient(), {
        organizationId: props.organization.id,
        teamId: team.id,
        etag: teamEtag,
        displayName
      }, { csrfToken: readCsrfCredential() });
      setTeam(result.data);
      setTeamEtag(result.etag);
      setTeams((items) => items.map((item) => item.id === result.data.id ? result.data : item));
      setFeedback({ message: "Team name saved.", reconcile: false, tone: "success" });
    });
  }

  async function handleDelete() {
    if (team === undefined || teamEtag === undefined || deleteConfirmation !== team.slug) return;
    await runMutation(async () => {
      await deleteTeam(createBrowserApiClient(), {
        organizationId: props.organization.id,
        teamId: team.id,
        etag: teamEtag
      }, { csrfToken: readCsrfCredential() });
      router.replace(teamHref(props.organization.id));
      router.refresh();
    });
  }

  async function handleAddMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (team === undefined) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    await runMutation(async () => {
      const result = await addTeamMember(createBrowserApiClient(), {
        organizationId: props.organization.id,
        teamId: team.id,
        userId: String(data.get("userId") ?? ""),
        role: teamRole(data.get("role"))
      }, { csrfToken: readCsrfCredential() });
      setMembers((items) => [...items, result.data]);
      setFeedback({ message: "Team member added.", reconcile: false, tone: "success" });
      form.reset();
    });
  }

  async function handleMemberRole(member: TeamMember, role: TeamRole) {
    if (team === undefined || member.role === role) return;
    await runMutation(async () => {
      const result = await changeTeamMemberRole(createBrowserApiClient(), {
        organizationId: props.organization.id,
        teamId: team.id,
        userId: member.userId,
        etag: memberEtag(member),
        role
      }, { csrfToken: readCsrfCredential() });
      setMembers((items) => items.map(
        (item) => item.userId === member.userId ? result.data : item
      ));
      setFeedback({ message: "Team member role saved.", reconcile: false, tone: "success" });
      if (member.userId === props.currentUserId) router.refresh();
    });
  }

  async function handleRemoveMember(member: TeamMember) {
    if (team === undefined) return;
    await runMutation(async () => {
      await removeTeamMember(createBrowserApiClient(), {
        organizationId: props.organization.id,
        teamId: team.id,
        userId: member.userId,
        etag: memberEtag(member)
      }, { csrfToken: readCsrfCredential() });
      setMembers((items) => items.filter((item) => item.userId !== member.userId));
      setFeedback({ message: "Team member removed.", reconcile: false, tone: "success" });
    });
  }

  async function handleAddProjectRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (team === undefined) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    await runMutation(async () => {
      const result = await addTeamProjectRole(createBrowserApiClient(), {
        organizationId: props.organization.id,
        teamId: team.id,
        projectId: String(data.get("projectId") ?? ""),
        role: projectRole(data.get("role"))
      }, { csrfToken: readCsrfCredential() });
      setProjectRoles((items) => [...items, result.data]);
      setFeedback({ message: "Project access granted to the Team.", reconcile: false, tone: "success" });
      form.reset();
    });
  }

  async function handleProjectRole(grant: TeamProjectRole, role: ProjectRole) {
    if (team === undefined || grant.role === role) return;
    await runMutation(async () => {
      const result = await changeTeamProjectRole(createBrowserApiClient(), {
        organizationId: props.organization.id,
        teamId: team.id,
        projectId: grant.projectId,
        etag: projectRoleEtag(grant),
        role
      }, { csrfToken: readCsrfCredential() });
      setProjectRoles((items) => items.map(
        (item) => item.projectId === grant.projectId ? result.data : item
      ));
      setFeedback({ message: "Team Project role saved.", reconcile: false, tone: "success" });
    });
  }

  async function handleRemoveProjectRole(grant: TeamProjectRole) {
    if (team === undefined) return;
    await runMutation(async () => {
      await removeTeamProjectRole(createBrowserApiClient(), {
        organizationId: props.organization.id,
        teamId: team.id,
        projectId: grant.projectId,
        etag: projectRoleEtag(grant)
      }, { csrfToken: readCsrfCredential() });
      setProjectRoles((items) => items.filter((item) => item.projectId !== grant.projectId));
      setFeedback({ message: "Team Project access removed.", reconcile: false, tone: "success" });
    });
  }

  return (
    <main id="main-content" className="workspace-page team-page" tabIndex={-1}>
      <header className="workspace-page__intro">
        <p className="eyebrow">{props.organization.displayName}</p>
        <h1>Teams</h1>
        <p>Group Organization members, then grant each Team access to selected Projects.</p>
      </header>

      <nav className="organization-tabs" aria-label="Organization settings">
        <Link href={`/organizations?organization=${props.organization.id}`}>Organization</Link>
        <Link href={teamHref(props.organization.id)} aria-current="page">Teams</Link>
      </nav>

      <div className="team-layout">
        <aside className="team-sidebar" aria-label="Team selection">
          {props.canCreateTeam ? (
            <form className="collaboration-form" onSubmit={handleCreate} aria-busy={mutation.isPending}>
              <h2>Create Team</h2>
              <label className="field-group">
                Slug
                <input name="slug" required pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" maxLength={63} disabled={mutation.isPending} />
              </label>
              <label className="field-group">
                Display name
                <input name="displayName" required maxLength={200} disabled={mutation.isPending} />
              </label>
              <Button type="submit" variant="primary" disabled={mutation.isPending}>Create Team</Button>
            </form>
          ) : (
            <div className="team-access-note">
              <strong>Organization Member access</strong>
              <p>You can open Teams you belong to. Organization Owners create and delete Teams.</p>
            </div>
          )}

          <nav aria-label="Teams">
            <h2 className="team-sidebar__heading">Available Teams</h2>
            {teams.length === 0 ? (
              <p className="team-empty-copy">No Teams are available to you.</p>
            ) : (
              <ul className="record-list team-list">
                {teams.map((item) => (
                  <li key={item.id}>
                    <Link href={teamHref(props.organization.id, item.id)} aria-current={team?.id === item.id ? "page" : undefined}>
                      <strong>{item.displayName}</strong>
                      <span>{item.slug}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </nav>
        </aside>

        <section className="team-detail" aria-labelledby="team-detail-title">
          {team === undefined ? (
            <div className="team-empty-state">
              <p className="eyebrow">Team access</p>
              <h2 id="team-detail-title">Select a Team</h2>
              <p>Choose a Team to review its members and Project roles.</p>
            </div>
          ) : (
            <>
              <header className="team-detail__header">
                <div>
                  <p className="eyebrow">{team.slug}</p>
                  <h2 id="team-detail-title">{team.displayName}</h2>
                </div>
                <span className="team-version" aria-label={`Team version ${team.version}`}>v{team.version}</span>
              </header>

              {feedback === undefined ? null : (
                <div className={`team-feedback team-feedback--${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"} aria-live="polite">
                  <p>{feedback.message}</p>
                  {feedback.reconcile ? <Button type="button" size="sm" onClick={() => router.refresh()}>Reload latest Team</Button> : null}
                </div>
              )}

              <section className="team-section" aria-labelledby="team-profile-title">
                <div className="team-section__heading">
                  <div><h3 id="team-profile-title">Profile</h3><p>The slug is permanent; the display name can change.</p></div>
                </div>
                {props.canRenameTeam ? (
                  <form className="team-inline-form" onSubmit={handleRename} aria-busy={mutation.isPending}>
                    <label className="field-group">Display name<input name="displayName" defaultValue={team.displayName} required maxLength={200} disabled={mutation.isPending} /></label>
                    <Button type="submit" disabled={mutation.isPending}>Save name</Button>
                  </form>
                ) : <p className="team-read-only">Your Team membership is read-only.</p>}
              </section>

              <TeamMembers
                canManage={props.canManageMembers}
                currentUserId={props.currentUserId}
                disabled={mutation.isPending}
                memberById={memberById}
                memberOptions={memberOptions}
                members={members}
                onAdd={handleAddMember}
                onRemove={handleRemoveMember}
                onRoleChange={handleMemberRole}
              />

              <TeamProjectRoles
                canManage={props.canManageProjectRoles}
                disabled={mutation.isPending}
                grants={projectRoles}
                onAdd={handleAddProjectRole}
                onRemove={handleRemoveProjectRole}
                onRoleChange={handleProjectRole}
                projectById={projectById}
                projectOptions={projectOptions}
              />

              {props.canDeleteTeam ? (
                <section className="team-section team-danger-zone" aria-labelledby="team-delete-title">
                  <div className="team-section__heading"><div><h3 id="team-delete-title">Delete Team</h3><p>Removes this Team, its memberships, and its Project grants. Projects are not deleted.</p></div></div>
                  <label className="field-group">Type <strong>{team.slug}</strong> to confirm<input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.currentTarget.value)} autoComplete="off" spellCheck={false} disabled={mutation.isPending} /></label>
                  <Button type="button" variant="danger" disabled={mutation.isPending || deleteConfirmation !== team.slug} onClick={() => void handleDelete()}>Delete Team</Button>
                </section>
              ) : null}
            </>
          )}
        </section>
      </div>
    </main>
  );
}

interface TeamMembersProps {
  readonly canManage: boolean;
  readonly currentUserId: string;
  readonly disabled: boolean;
  readonly memberById: ReadonlyMap<string, OrganizationMemberOption>;
  readonly memberOptions: readonly OrganizationMemberOption[];
  readonly members: readonly TeamMember[];
  readonly onAdd: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly onRemove: (member: TeamMember) => Promise<void>;
  readonly onRoleChange: (member: TeamMember, role: TeamRole) => Promise<void>;
}

function TeamMembers(props: TeamMembersProps) {
  return (
    <section className="team-section" aria-labelledby="team-members-title">
      <div className="team-section__heading"><div><h3 id="team-members-title">Members</h3><p>Maintainers manage the Team roster. Members can view Team resources.</p></div><span>{props.members.length}</span></div>
      {props.canManage ? (
        <form className="team-add-form" onSubmit={props.onAdd} aria-busy={props.disabled}>
          <div className="field-group"><label htmlFor="team-member-user">Organization member</label><select id="team-member-user" name="userId" required disabled={props.disabled || props.memberOptions.length === 0} defaultValue=""><option value="" disabled>Select a member</option>{props.memberOptions.map((member) => <option key={member.userId} value={member.userId}>{member.displayName} · Organization {member.organizationRole} · {shortId(member.userId)}</option>)}</select></div>
          <div className="field-group"><label htmlFor="team-member-new-role">Team role</label><select id="team-member-new-role" name="role" defaultValue="member" disabled={props.disabled}><option value="member">Member</option><option value="maintainer">Maintainer</option></select></div>
          <Button type="submit" disabled={props.disabled || props.memberOptions.length === 0}>Add member</Button>
        </form>
      ) : null}
      {props.members.length === 0 ? <p className="team-empty-copy">This Team has no members.</p> : (
        <ul className="record-list team-records" aria-label="Team members">
          {props.members.map((member, index) => {
            const organizationMember = props.memberById.get(member.userId);
            const label = organizationMember?.displayName ?? `Unavailable member ${index + 1}`;
            return <li key={member.userId}><div><strong>{label}{member.userId === props.currentUserId ? " (you)" : ""}</strong><span>Organization {organizationMember?.organizationRole ?? "membership unavailable"}</span></div>{props.canManage ? <div className="record-actions"><label className="sr-only" htmlFor={`team-member-role-${member.userId}`}>Role for {label}</label><select id={`team-member-role-${member.userId}`} value={member.role} disabled={props.disabled} onChange={(event) => void props.onRoleChange(member, teamRole(event.currentTarget.value))}><option value="member">Member</option><option value="maintainer">Maintainer</option></select><Button type="button" size="sm" disabled={props.disabled || member.userId === props.currentUserId} aria-label={`Remove ${label} from Team`} onClick={() => void props.onRemove(member)}>Remove</Button></div> : <span className="team-role-badge">{member.role}</span>}</li>;
          })}
        </ul>
      )}
    </section>
  );
}

interface TeamProjectRolesProps {
  readonly canManage: boolean;
  readonly disabled: boolean;
  readonly grants: readonly TeamProjectRole[];
  readonly onAdd: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly onRemove: (grant: TeamProjectRole) => Promise<void>;
  readonly onRoleChange: (grant: TeamProjectRole, role: ProjectRole) => Promise<void>;
  readonly projectById: ReadonlyMap<string, ProjectOption>;
  readonly projectOptions: readonly ProjectOption[];
}

function TeamProjectRoles(props: TeamProjectRolesProps) {
  return (
    <section className="team-section" aria-labelledby="team-projects-title">
      <div className="team-section__heading"><div><h3 id="team-projects-title">Project access</h3><p>Read can inspect, Write can change content, and Admin can manage the Project. Team roles alone grant no Project access.</p></div><span>{props.grants.length}</span></div>
      {props.canManage ? (
        <form className="team-add-form" onSubmit={props.onAdd} aria-busy={props.disabled}>
          <div className="field-group"><label htmlFor="team-project-new">Project</label><select id="team-project-new" name="projectId" required disabled={props.disabled || props.projectOptions.length === 0} defaultValue=""><option value="" disabled>Select a Project</option>{props.projectOptions.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.slug}</option>)}</select></div>
          <div className="field-group"><label htmlFor="team-project-new-role">Project role</label><select id="team-project-new-role" name="role" defaultValue="read" disabled={props.disabled}><option value="read">Read</option><option value="write">Write</option><option value="admin">Admin</option></select></div>
          <Button type="submit" disabled={props.disabled || props.projectOptions.length === 0}>Grant access</Button>
        </form>
      ) : <p className="team-read-only">Only Organization Owners can change Team Project grants.</p>}
      {props.grants.length === 0 ? <p className="team-empty-copy">This Team has no Project access.</p> : (
        <ul className="record-list team-records" aria-label="Team Project roles">
          {props.grants.map((grant, index) => {
            const project = props.projectById.get(grant.projectId);
            const label = project?.name ?? `Unavailable Project ${index + 1}`;
            return <li key={grant.projectId}><div><strong>{label}</strong><span>{project?.slug ?? "Project details unavailable"}</span></div>{props.canManage ? <div className="record-actions"><label className="sr-only" htmlFor={`team-project-role-${grant.projectId}`}>Role for {label}</label><select id={`team-project-role-${grant.projectId}`} value={grant.role} disabled={props.disabled} onChange={(event) => void props.onRoleChange(grant, projectRole(event.currentTarget.value))}><option value="read">Read</option><option value="write">Write</option><option value="admin">Admin</option></select><Button type="button" size="sm" disabled={props.disabled} aria-label={`Remove ${label} access`} onClick={() => void props.onRemove(grant)}>Remove</Button></div> : <span className="team-role-badge">{grant.role}</span>}</li>;
          })}
        </ul>
      )}
    </section>
  );
}

function availableMemberOptions(
  organizationMembers: readonly OrganizationMemberOption[],
  members: readonly TeamMember[]
): readonly OrganizationMemberOption[] {
  const assigned = new Set(members.map((member) => member.userId));
  return organizationMembers.filter((member) => !assigned.has(member.userId));
}

function shortId(value: string): string {
  return value.slice(-8);
}

function teamHref(organizationId: string, teamId?: string): string {
  const base = `/organizations/${organizationId}/teams`;
  return teamId === undefined ? base : `${base}?team=${teamId}`;
}

function memberEtag(member: TeamMember): string {
  return `"team-member-v${member.version}"`;
}

function projectRoleEtag(grant: TeamProjectRole): string {
  return `"team-project-role-v${grant.version}"`;
}

function teamRole(value: FormDataEntryValue | null): TeamRole {
  return value === "maintainer" ? "maintainer" : "member";
}

function projectRole(value: FormDataEntryValue | null): ProjectRole {
  if (value === "admin" || value === "write") return value;
  return "read";
}

function teamFailure(cause: unknown): Feedback {
  if (cause instanceof ApiError) {
    if (cause.status === 403) return { message: "You do not have permission for this Team action.", reconcile: false, tone: "error" };
    if (cause.status === 412 || cause.status === 428 || cause.code === "COMMIT_OUTCOME_UNKNOWN") return { message: "This Team changed or the server outcome is unknown. Reload the latest Team before continuing.", reconcile: true, tone: "error" };
    if (cause.status === 409) return { message: "That value already exists or the Team changed. Review the latest Team state.", reconcile: true, tone: "error" };
    if (cause.status === 400 || cause.status === 422) return { message: "Some submitted values are invalid. Review the form and try again.", reconcile: false, tone: "error" };
  }
  return { message: "The Team request could not be completed. Check the service and try again.", reconcile: false, tone: "error" };
}
