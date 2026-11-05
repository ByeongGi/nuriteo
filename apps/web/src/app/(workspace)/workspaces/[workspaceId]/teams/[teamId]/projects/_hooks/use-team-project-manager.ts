"use client";

import { useRouter } from "next/navigation";
import { useDeferredValue, useMemo, useState } from "react";

import { teamProjectAddSchema, teamProjectRoleSchema } from "@/app/(workspace)/workspaces/[workspaceId]/teams/[teamId]/projects/_schema/team-project.ts";
import { teamErrorMessage, teamProjectRoleEtag } from "@/app/(workspace)/workspaces/[workspaceId]/teams/_utils/team-error.ts";
import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { addTeamProjectRole, changeTeamProjectRole, removeTeamProjectRole } from "@/services/teams/api.ts";

import type { FormEvent } from "react";
import type { Project, Team, TeamProjectRole } from "@nuriteo/api-client";

export function useTeamProjectManager({
  grants,
  organizationId,
  projects,
  team
}: {
  readonly grants: readonly TeamProjectRole[];
  readonly organizationId: string;
  readonly projects: readonly Project[];
  readonly team: Team;
}) {
  const mutation = useExclusiveMutation();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const deferredQuery = useDeferredValue(query);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project] as const)), [projects]);
  const availableProjects = projects.filter((project) => !grants.some((grant) => grant.projectId === project.id));
  const visibleGrants = useMemo(() => { const normalized = deferredQuery.trim().toLocaleLowerCase("ko-KR"); return normalized === "" ? grants : grants.filter((grant) => { const project = projectById.get(grant.projectId); return `${project?.name ?? ""} ${project?.slug ?? ""} ${grant.role}`.toLocaleLowerCase("ko-KR").includes(normalized); }); }, [deferredQuery, grants, projectById]);

  async function run(action: () => Promise<void>, message: string) { await mutation.run(async () => { setError(undefined); setStatus(undefined); try { await action(); setStatus(message); router.refresh(); } catch (cause) { setError(teamErrorMessage(cause)); } }); }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = teamProjectAddSchema.safeParse({
      projectId: String(data.get("projectId") ?? ""),
      role: String(data.get("role") ?? "")
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "입력값을 확인하세요.");
      return;
    }
    await run(async () => { await addTeamProjectRole(createBrowserApiClient(), { organizationId, teamId: team.id, projectId: parsed.data.projectId, role: parsed.data.role }, { csrfToken: readCsrfCredential() }); }, "프로젝트 접근 권한을 부여했습니다.");
  }

  async function changeRole(grant: TeamProjectRole, role: string) {
    const parsed = teamProjectRoleSchema.safeParse({ role });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "입력값을 확인하세요.");
      return;
    }
    if (grant.role === parsed.data.role) return;
    await run(async () => { await changeTeamProjectRole(createBrowserApiClient(), { organizationId, teamId: team.id, projectId: grant.projectId, etag: teamProjectRoleEtag(grant.version), role: parsed.data.role }, { csrfToken: readCsrfCredential() }); }, "프로젝트 역할을 저장했습니다.");
  }

  async function remove(grant: TeamProjectRole) { await run(async () => { await removeTeamProjectRole(createBrowserApiClient(), { organizationId, teamId: team.id, projectId: grant.projectId, etag: teamProjectRoleEtag(grant.version) }, { csrfToken: readCsrfCredential() }); }, "프로젝트 접근 권한을 제거했습니다."); }

  return {
    add,
    availableProjects,
    changeRole,
    deferredQuery,
    error,
    isPending: mutation.isPending,
    projectById,
    query,
    remove,
    setQuery,
    status,
    visibleGrants
  };
}
