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
import {
  collaborationError,
  readCsrfCredential
} from "../../../lib/api/browser-security.ts";
import type { CollaborationOperation } from "../../../lib/api/browser-security.ts";
import { createBrowserApiClient } from "../../../lib/api/browser-client.ts";
import { useExclusiveMutation } from "../../../lib/use-exclusive-mutation.ts";

interface OrganizationConsoleProps {
  readonly canManage: boolean;
  readonly currentUserId: string;
  readonly etag?: string;
  readonly invitations?: readonly OrganizationInvitation[];
  readonly members?: readonly OrganizationMember[];
  readonly organization?: Organization;
  readonly workspaces: readonly Workspace[];
}

export function OrganizationConsole(props: OrganizationConsoleProps) {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [oneTimeUrl, setOneTimeUrl] = useState<string>();
  const [deliveryNotice, setDeliveryNotice] = useState<string>();
  const [error, setError] = useState<string>();

  async function mutate(
    operation: CollaborationOperation,
    action: () => Promise<void>,
    refreshAfterSuccess = true
  ) {
    await mutation.run(async () => {
      setError(undefined);
      setOneTimeUrl(undefined);
      setDeliveryNotice(undefined);
      try {
        await action();
        if (refreshAfterSuccess) router.refresh();
      } catch (cause) {
        setError(collaborationError(cause, operation));
      }
    });
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await mutate("organization-create", async () => {
      const result = await createOrganization(
        createBrowserApiClient(),
        {
          slug: String(data.get("slug") ?? ""),
          displayName: String(data.get("displayName") ?? "")
        },
        { csrfToken: readCsrfCredential() }
      );
      router.replace(`/organizations?organization=${result.data.id}`);
    }, false);
  }

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!props.organization || !props.etag) return;
    const data = new FormData(event.currentTarget);
    await mutate("organization-profile", async () => {
      await updateOrganization(
        createBrowserApiClient(),
        {
          organizationId: props.organization!.id,
          displayName: String(data.get("displayName") ?? ""),
          etag: props.etag!
        },
        { csrfToken: readCsrfCredential() }
      );
    });
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!props.organization) return;
    const form = event.currentTarget;
    const data = new FormData(event.currentTarget);
    await mutate("organization-invitation-issue", async () => {
      const result = await issueOrganizationInvitation(
        createBrowserApiClient(),
        {
          organizationId: props.organization!.id,
          email: String(data.get("email") ?? ""),
          role: String(data.get("role")) === "owner" ? "owner" : "member"
        },
        { csrfToken: readCsrfCredential() }
      );
      if (result.data.delivery === "email_queued") {
        setDeliveryNotice("The organization invitation email is queued for delivery.");
      } else {
        setOneTimeUrl(result.data.acceptUrl.consume());
      }
      form.reset();
    }, false);
  }

  async function reissue(invitation: OrganizationInvitation) {
    if (!props.organization) return;
    await mutate("organization-invitation-terminal", async () => {
      const result = await reissueOrganizationInvitation(
        createBrowserApiClient(),
        {
          organizationId: props.organization!.id,
          invitationId: invitation.id,
          role: invitation.proposedRole
        },
        { csrfToken: readCsrfCredential() }
      );
      if (result.data.delivery === "email_queued") {
        setDeliveryNotice("The replacement invitation email is queued for delivery.");
      } else {
        setOneTimeUrl(result.data.acceptUrl.consume());
      }
    }, false);
  }

  async function changeRole(member: OrganizationMember) {
    if (!props.organization) return;
    await mutate("organization-member", async () => {
      await changeOrganizationMemberRole(
        createBrowserApiClient(),
        {
          organizationId: props.organization!.id,
          userId: member.userId,
          role: member.role === "owner" ? "member" : "owner"
        },
        { csrfToken: readCsrfCredential() }
      );
    });
  }

  async function remove(member: OrganizationMember) {
    if (!props.organization) return;
    await mutate("organization-member", async () => {
      await removeOrganizationMember(
        createBrowserApiClient(),
        { organizationId: props.organization!.id, userId: member.userId },
        { csrfToken: readCsrfCredential() }
      );
    });
  }

  return (
    <main id="main-content" className="workspace-page">
      <header className="workspace-page__intro">
        <p className="eyebrow">Collaboration</p>
        <h1>Organizations</h1>
        <p>Create a shared Workspace, then manage members and invitations.</p>
      </header>
      <nav className="organization-tabs" aria-label="Organizations">
        <Link href="/organizations" aria-current={!props.organization ? "page" : undefined}>Create new</Link>
        {props.workspaces.filter((workspace) => workspace.ownerType === "organization").map((workspace) => (
          <Link key={workspace.ownerId} href={`/organizations?organization=${workspace.ownerId}`} aria-current={props.organization?.id === workspace.ownerId ? "page" : undefined}>
            {workspace.displayLabel}
          </Link>
        ))}
      </nav>
      {props.organization ? (
        <nav className="organization-actions" aria-label={`${props.organization.displayName} settings`}>
          <Link href={`/organizations/${props.organization.id}/teams`}>Manage Teams</Link>
        </nav>
      ) : null}
      {oneTimeUrl ? (
        <section className="one-time-panel" aria-labelledby="organization-invitation-link-title" aria-live="polite">
          <h2 id="organization-invitation-link-title">Copy this invitation link now</h2>
          <p>This one-time link will not be shown again after you leave or refresh this page.</p>
          <output aria-labelledby="organization-invitation-link-title">{oneTimeUrl}</output>
          <Button type="button" onClick={() => { setOneTimeUrl(undefined); router.refresh(); }}>Clear link</Button>
        </section>
      ) : null}
      {deliveryNotice ? <p role="status">{deliveryNotice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {!props.organization ? (
        <form className="collaboration-form" onSubmit={create} aria-busy={mutation.isPending}>
          <h2>Create Organization</h2>
          <label className="field-group">Slug<input name="slug" required pattern="[a-z0-9][a-z0-9-]*" maxLength={63} disabled={mutation.isPending} /></label>
          <label className="field-group">Display name<input name="displayName" required maxLength={200} disabled={mutation.isPending} /></label>
          <Button type="submit" variant="primary" disabled={mutation.isPending}>Create Organization</Button>
        </form>
      ) : null}
      {props.organization ? (
        <section className="collaboration-grid">
          <div>
            <h2>{props.organization.displayName}</h2>
            <p>Status: {props.organization.status} · version {props.organization.version}</p>
            {props.canManage ? (
              <form className="collaboration-form" onSubmit={rename} aria-busy={mutation.isPending}>
                <label className="field-group">Display name<input name="displayName" defaultValue={props.organization.displayName} required disabled={mutation.isPending} /></label>
                <Button type="submit" disabled={mutation.isPending}>Save name</Button>
              </form>
            ) : <p>Member access is read-only. The server enforces every mutation.</p>}
          </div>
          <div>
            <h2>Members</h2>
            <ul className="record-list">
              {props.members?.map((member) => (
                <li key={member.userId}>
                  <div><strong>{member.displayName}</strong><span>{member.role}</span></div>
                  {props.canManage && member.userId !== props.currentUserId ? (
                    <div className="record-actions">
                      <Button type="button" disabled={mutation.isPending} onClick={() => void changeRole(member)}>Make {member.role === "owner" ? "member" : "owner"}</Button>
                      <Button type="button" disabled={mutation.isPending} onClick={() => void remove(member)}>Remove</Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
          {props.canManage ? (
            <div>
              <h2>Invite member</h2>
              <form className="collaboration-form" onSubmit={invite} aria-busy={mutation.isPending}>
                <label className="field-group">Invitee email<input name="email" type="text" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} aria-describedby="organization-invitation-email-help" required disabled={mutation.isPending} /></label>
                <p id="organization-invitation-email-help">Enter the existing account email using 3 to 320 Unicode characters.</p>
                <label className="field-group">Role<select name="role" required disabled={mutation.isPending}><option value="member">Member</option><option value="owner">Owner</option></select></label>
                <Button type="submit" variant="primary" disabled={mutation.isPending}>Issue Organization invitation</Button>
              </form>
              <ul className="record-list" aria-label="Organization invitations">
                {props.invitations?.map((invitation) => (
                  <li key={invitation.id}>
                    <div><strong>{invitation.proposedRole} invitation</strong><span>Invitation status: {invitation.status} · expires {invitation.expiresAt}</span></div>
                    {invitation.status === "pending" ? (
                      <div className="record-actions">
                        <Button type="button" disabled={mutation.isPending} onClick={() => void reissue(invitation)}>Reissue</Button>
                        <Button type="button" disabled={mutation.isPending} onClick={() => void mutate("organization-invitation-terminal", async () => {
                          await revokeOrganizationInvitation(
                            createBrowserApiClient(),
                            { organizationId: props.organization!.id, invitationId: invitation.id },
                            { csrfToken: readCsrfCredential() }
                          );
                        })}>Revoke</Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
