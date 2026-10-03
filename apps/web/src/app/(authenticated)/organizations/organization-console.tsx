"use client";

import {
  changeOrganizationMemberRole,
  createOrganization,
  issueOrganizationInvitation,
  reissueOrganizationInvitation,
  removeOrganizationMember,
  revokeOrganizationInvitation,
  updateOrganization
} from "@nuriteo/api-client";
import type {
  Organization,
  OrganizationInvitation,
  OrganizationMember,
  Workspace
} from "@nuriteo/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "../../../components/ui/button.tsx";
import { collaborationError, readCsrfCredential } from "../../../lib/api/browser-security.ts";
import { createBrowserApiClient } from "../../../lib/api/browser-client.ts";

interface OrganizationConsoleProps {
  readonly currentUserId: string;
  readonly etag?: string;
  readonly invitations?: readonly OrganizationInvitation[];
  readonly members?: readonly OrganizationMember[];
  readonly organization?: Organization;
  readonly workspaces: readonly Workspace[];
}

export function OrganizationConsole(props: OrganizationConsoleProps) {
  const router = useRouter();
  const [oneTimeUrl, setOneTimeUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const isOwner = props.members?.some((member) => member.userId === props.currentUserId && member.role === "owner") === true;

  async function mutate(action: () => Promise<unknown>) {
    setError(undefined);
    setOneTimeUrl(undefined);
    try { await action(); router.refresh(); } catch (cause) { setError(collaborationError(cause)); }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await mutate(async () => {
      const result = await createOrganization(createBrowserApiClient(), { slug: String(data.get("slug") ?? ""), displayName: String(data.get("displayName") ?? "") }, { csrfToken: readCsrfCredential() });
      router.replace(`/organizations?organization=${result.data.id}`);
    });
  }

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!props.organization || !props.etag) return;
    const data = new FormData(event.currentTarget);
    await mutate(() => updateOrganization(createBrowserApiClient(), { organizationId: props.organization!.id, displayName: String(data.get("displayName") ?? ""), etag: props.etag! }, { csrfToken: readCsrfCredential() }));
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!props.organization) return;
    const data = new FormData(event.currentTarget);
    await mutate(async () => {
      const result = await issueOrganizationInvitation(createBrowserApiClient(), { organizationId: props.organization!.id, inviteeUserId: String(data.get("inviteeUserId") ?? ""), role: String(data.get("role")) === "owner" ? "owner" : "member" }, { csrfToken: readCsrfCredential() });
      setOneTimeUrl(result.data.acceptUrl.consume());
    });
  }

  async function reissue(invitation: OrganizationInvitation) {
    if (!props.organization) return;
    await mutate(async () => {
      const result = await reissueOrganizationInvitation(createBrowserApiClient(), { organizationId: props.organization!.id, invitationId: invitation.id, role: invitation.proposedRole }, { csrfToken: readCsrfCredential() });
      setOneTimeUrl(result.data.acceptUrl.consume());
    });
  }

  return (
    <main id="main-content" className="workspace-page">
      <header className="workspace-page__intro"><p className="eyebrow">Collaboration</p><h1>Organizations</h1><p>Create a shared Workspace, then manage members and invitations.</p></header>
      <nav className="organization-tabs" aria-label="Organizations"><Link href="/organizations" aria-current={!props.organization ? "page" : undefined}>Create new</Link>{props.workspaces.filter((workspace) => workspace.ownerType === "organization").map((workspace) => <Link key={workspace.ownerId} href={`/organizations?organization=${workspace.ownerId}`} aria-current={props.organization?.id === workspace.ownerId ? "page" : undefined}>{workspace.displayLabel}</Link>)}</nav>
      {oneTimeUrl ? <section className="one-time-panel" aria-live="polite"><h2>Copy this invitation link now</h2><output>{oneTimeUrl}</output><Button type="button" onClick={() => setOneTimeUrl(undefined)}>Clear link</Button></section> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {!props.organization ? <form className="collaboration-form" onSubmit={create}><h2>Create Organization</h2><label className="field-group">Slug<input name="slug" required pattern="[a-z0-9][a-z0-9-]*" maxLength={63} /></label><label className="field-group">Display name<input name="displayName" required maxLength={200} /></label><Button type="submit" variant="primary">Create Organization</Button></form> : null}
      {props.organization ? <section className="collaboration-grid"><div><h2>{props.organization.displayName}</h2><p>Status: {props.organization.status} · version {props.organization.version}</p>{isOwner ? <form className="collaboration-form" onSubmit={rename}><label className="field-group">Display name<input name="displayName" defaultValue={props.organization.displayName} required /></label><Button type="submit">Save name</Button></form> : <p>Member access is read-only. The server enforces every mutation.</p>}</div><div><h2>Members</h2><ul className="record-list">{props.members?.map((member) => <li key={member.userId}><div><strong>{member.displayName}</strong><span>{member.role}</span></div>{isOwner && member.userId !== props.currentUserId ? <div className="record-actions"><Button type="button" onClick={() => void mutate(() => changeOrganizationMemberRole(createBrowserApiClient(), { organizationId: props.organization!.id, userId: member.userId, role: member.role === "owner" ? "member" : "owner" }, { csrfToken: readCsrfCredential() }))}>Make {member.role === "owner" ? "member" : "owner"}</Button><Button type="button" onClick={() => void mutate(() => removeOrganizationMember(createBrowserApiClient(), { organizationId: props.organization!.id, userId: member.userId }, { csrfToken: readCsrfCredential() }))}>Remove</Button></div> : null}</li>)}</ul></div>{isOwner ? <div><h2>Invite member</h2><form className="collaboration-form" onSubmit={invite}><label className="field-group">Invitee user ID<input name="inviteeUserId" required /></label><label className="field-group">Role<select name="role"><option value="member">Member</option><option value="owner">Owner</option></select></label><Button type="submit" variant="primary">Issue Organization invitation</Button></form><ul className="record-list" aria-label="Organization invitations">{props.invitations?.map((invitation) => <li key={invitation.id}><div><strong>{invitation.proposedRole}</strong><span>{invitation.status} · expires {invitation.expiresAt}</span></div>{invitation.status === "pending" ? <div className="record-actions"><Button type="button" onClick={() => void reissue(invitation)}>Reissue</Button><Button type="button" onClick={() => void mutate(() => revokeOrganizationInvitation(createBrowserApiClient(), { organizationId: props.organization!.id, invitationId: invitation.id }, { csrfToken: readCsrfCredential() }))}>Revoke</Button></div> : null}</li>)}</ul></div> : null}</section> : null}
    </main>
  );
}
