"use client";

import { useRouter } from "next/navigation";
import { useDeferredValue, useMemo, useState } from "react";

import { teamMemberAddSchema, teamMemberRoleSchema } from "@/app/(workspace)/workspaces/[workspaceId]/teams/[teamId]/members/_schema/team-member.ts";
import { teamErrorMessage, teamMemberEtag } from "@/app/(workspace)/workspaces/[workspaceId]/teams/_utils/team-error.ts";
import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { addTeamMember, changeTeamMemberRole, removeTeamMember } from "@/services/teams/api.ts";

import type { FormEvent } from "react";
import type { OrganizationMember, Team, TeamMember } from "@nuriteo/api-client";

export function useTeamMemberManager({
  members,
  organizationId,
  organizationMembers,
  team
}: {
  readonly members: readonly TeamMember[];
  readonly organizationId: string;
  readonly organizationMembers: readonly OrganizationMember[];
  readonly team: Team;
}) {
  const mutation = useExclusiveMutation();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const deferredQuery = useDeferredValue(query);
  const memberById = useMemo(() => new Map(organizationMembers.map((member) => [member.userId, member] as const)), [organizationMembers]);
  const availableMembers = organizationMembers.filter((candidate) => !members.some((member) => member.userId === candidate.userId));
  const visibleMembers = useMemo(() => {
    const normalized = deferredQuery.trim().toLocaleLowerCase("ko-KR");
    return normalized === "" ? members : members.filter((member) => `${memberById.get(member.userId)?.displayName ?? ""} ${member.role} ${member.userId}`.toLocaleLowerCase("ko-KR").includes(normalized));
  }, [deferredQuery, memberById, members]);

  async function run(action: () => Promise<void>, message: string) {
    await mutation.run(async () => {
      setError(undefined); setStatus(undefined);
      try { await action(); setStatus(message); router.refresh(); } catch (cause) { setError(teamErrorMessage(cause)); }
    });
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = teamMemberAddSchema.safeParse({
      userId: String(data.get("userId") ?? ""),
      role: String(data.get("role") ?? "")
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "입력값을 확인하세요.");
      return;
    }
    await run(async () => { await addTeamMember(createBrowserApiClient(), { organizationId, teamId: team.id, userId: parsed.data.userId, role: parsed.data.role }, { csrfToken: readCsrfCredential() }); }, "팀 멤버를 추가했습니다.");
  }

  async function changeRole(member: TeamMember, role: string) {
    const parsed = teamMemberRoleSchema.safeParse({ role });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "입력값을 확인하세요.");
      return;
    }
    if (member.role === parsed.data.role) return;
    await run(async () => { await changeTeamMemberRole(createBrowserApiClient(), { organizationId, teamId: team.id, userId: member.userId, etag: teamMemberEtag(member.version), role: parsed.data.role }, { csrfToken: readCsrfCredential() }); }, "팀 멤버 역할을 저장했습니다.");
  }

  async function remove(member: TeamMember) {
    await run(async () => { await removeTeamMember(createBrowserApiClient(), { organizationId, teamId: team.id, userId: member.userId, etag: teamMemberEtag(member.version) }, { csrfToken: readCsrfCredential() }); }, "팀에서 멤버를 제외했습니다.");
  }

  return {
    add,
    availableMembers,
    changeRole,
    deferredQuery,
    error,
    isPending: mutation.isPending,
    memberById,
    query,
    remove,
    setQuery,
    status,
    visibleMembers
  };
}
