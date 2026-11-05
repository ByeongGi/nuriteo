"use client";

import { useRouter } from "next/navigation";
import { useDeferredValue, useMemo, useState } from "react";

import {
  createOrganizationSchema,
  issueOrganizationInvitationSchema,
  organizationFormError,
  renameOrganizationSchema
} from "@/app/(authenticated)/organizations/_schema/organization.ts";
import {
  issueOrganizationInvitation,
  reissueOrganizationInvitation,
  revokeOrganizationInvitation
} from "@/services/organization-invitations/api.ts";
import {
  changeOrganizationMemberRole,
  createOrganization,
  removeOrganizationMember,
  updateOrganization
} from "@/services/organizations/api.ts";
import { collaborationError, readCsrfCredential } from "@/lib/api/browser-security.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";

import type { CollaborationOperation } from "@/lib/api/browser-security.ts";
import type { Organization, OrganizationInvitation, OrganizationMember, Workspace } from "@nuriteo/api-client";
import type { FormEvent } from "react";

export interface OrganizationConsoleProps {
  readonly canManage: boolean;
  readonly currentUserId: string;
  readonly context?: "creation" | "standalone" | "workspace";
  readonly etag?: string;
  readonly invitations?: readonly OrganizationInvitation[];
  readonly members?: readonly OrganizationMember[];
  readonly organization?: Organization;
  readonly workspaces: readonly Workspace[];
}

export function useOrganizationConsole(props: OrganizationConsoleProps) {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [oneTimeUrl, setOneTimeUrl] = useState<string>();
  const [deliveryNotice, setDeliveryNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [memberQuery, setMemberQuery] = useState("");
  const [invitationFilter, setInvitationFilter] = useState<"all" | "pending">("pending");
  const deferredMemberQuery = useDeferredValue(memberQuery);
  const organizationWorkspaces = useMemo(
    () => props.workspaces.filter((workspace) => workspace.ownerType === "organization"),
    [props.workspaces]
  );
  const activeWorkspace = props.organization === undefined
    ? undefined
    : organizationWorkspaces.find((workspace) => workspace.ownerId === props.organization?.id);
  const visibleMembers = useMemo(() => {
    const query = deferredMemberQuery.trim().toLocaleLowerCase("ko-KR");
    if (query === "") return props.members ?? [];
    return (props.members ?? []).filter((member) =>
      `${member.displayName} ${member.role} ${member.userId}`.toLocaleLowerCase("ko-KR").includes(query)
    );
  }, [deferredMemberQuery, props.members]);
  const visibleInvitations = useMemo(
    () => (props.invitations ?? []).filter(
      (invitation) => invitationFilter === "all" || invitation.status === "pending"
    ),
    [invitationFilter, props.invitations]
  );

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
      const parsed = createOrganizationSchema.safeParse({
        slug: String(data.get("slug") ?? ""),
        displayName: String(data.get("displayName") ?? "")
      });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? organizationFormError);
        return;
      }
      await createOrganization(
        createBrowserApiClient(),
        parsed.data,
        { csrfToken: readCsrfCredential() }
      );
      router.replace("/workspaces");
    }, false);
  }

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!props.organization || !props.etag) return;
    const data = new FormData(event.currentTarget);
    const organizationId = props.organization.id;
    const etag = props.etag;
    await mutate("organization-profile", async () => {
      const parsed = renameOrganizationSchema.safeParse({
        displayName: String(data.get("displayName") ?? "")
      });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? organizationFormError);
        return;
      }
      await updateOrganization(
        createBrowserApiClient(),
        {
          organizationId,
          displayName: parsed.data.displayName,
          etag
        },
        { csrfToken: readCsrfCredential() }
      );
    });
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!props.organization) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const organizationId = props.organization.id;
    await mutate("organization-invitation-issue", async () => {
      const parsed = issueOrganizationInvitationSchema.safeParse({
        email: String(data.get("email") ?? ""),
        role: String(data.get("role") ?? "")
      });
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? organizationFormError);
        return;
      }
      const result = await issueOrganizationInvitation(
        createBrowserApiClient(),
        {
          organizationId,
          email: parsed.data.email,
          role: parsed.data.role
        },
        { csrfToken: readCsrfCredential() }
      );
      if (result.data.delivery === "email_queued") {
        setDeliveryNotice("조직 초대 이메일을 전송 대기열에 추가했습니다.");
      } else {
        setOneTimeUrl(result.data.acceptUrl.consume());
      }
      form.reset();
    }, false);
  }

  async function reissue(invitation: OrganizationInvitation) {
    if (!props.organization) return;
    const organizationId = props.organization.id;
    await mutate("organization-invitation-terminal", async () => {
      const result = await reissueOrganizationInvitation(
        createBrowserApiClient(),
        {
          organizationId,
          invitationId: invitation.id,
          role: invitation.proposedRole
        },
        { csrfToken: readCsrfCredential() }
      );
      if (result.data.delivery === "email_queued") {
        setDeliveryNotice("새 초대 이메일을 전송 대기열에 추가했습니다.");
      } else {
        setOneTimeUrl(result.data.acceptUrl.consume());
      }
    }, false);
  }

  async function changeRole(member: OrganizationMember) {
    if (!props.organization) return;
    const organizationId = props.organization.id;
    await mutate("organization-member", async () => {
      await changeOrganizationMemberRole(
        createBrowserApiClient(),
        {
          organizationId,
          userId: member.userId,
          role: member.role === "owner" ? "member" : "owner"
        },
        { csrfToken: readCsrfCredential() }
      );
    });
  }

  async function remove(member: OrganizationMember) {
    if (!props.organization) return;
    const organizationId = props.organization.id;
    await mutate("organization-member", async () => {
      await removeOrganizationMember(
        createBrowserApiClient(),
        { organizationId, userId: member.userId },
        { csrfToken: readCsrfCredential() }
      );
    });
  }

  async function revoke(invitation: OrganizationInvitation) {
    if (!props.organization) return;
    const organizationId = props.organization.id;
    await mutate("organization-invitation-terminal", async () => {
      await revokeOrganizationInvitation(
        createBrowserApiClient(),
        { organizationId, invitationId: invitation.id },
        { csrfToken: readCsrfCredential() }
      );
    });
  }

  function switchOrganization(organizationId: string) {
    const selected = organizationWorkspaces.find((workspace) => workspace.ownerId === organizationId);
    router.push(selected === undefined
      ? "/workspaces/new/organization"
      : `/workspaces/${encodeURIComponent(selected.storageScopeId)}/members`);
  }

  function dismissInvitationLink() {
    setOneTimeUrl(undefined);
    router.refresh();
  }

  return {
    activeWorkspace,
    changeRole,
    create,
    deferredMemberQuery,
    deliveryNotice,
    dismissInvitationLink,
    error,
    invitationFilter,
    invite,
    isPending: mutation.isPending,
    memberQuery,
    oneTimeUrl,
    organizationWorkspaces,
    reissue,
    remove,
    rename,
    revoke,
    setInvitationFilter,
    setMemberQuery,
    switchOrganization,
    visibleInvitations,
    visibleMembers
  };
}
