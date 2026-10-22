"use client";

import {
  ApiError,
  addTeamMember,
  addTeamProjectRole,
  changeTeamMemberRole,
  changeTeamProjectRole,
  createTeam,
  deleteTeam,
  listTeamMembers,
  listTeamProjectRoles,
  listTeams,
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
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import { Button } from "#src/components/ui/button.tsx";
import { SelectField } from "#src/components/ui/field.tsx";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

export interface OrganizationMemberOption {
  readonly displayName: string;
  readonly organizationRole: "owner" | "member";
  readonly userId: string;
}

export interface ProjectOption {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface TeamConsoleProps {
  readonly canCreateTeam: boolean;
  readonly canDeleteTeam: boolean;
  readonly canManageMembers: boolean;
  readonly canManageProjectRoles: boolean;
  readonly canRenameTeam: boolean;
  readonly currentUserId: string;
  readonly initialMemberNextCursor: string | null;
  readonly initialMembers: readonly TeamMember[];
  readonly initialNextTeamCursor: string | null;
  readonly initialProjectRoles: readonly TeamProjectRole[];
  readonly initialProjectRoleNextCursor: string | null;
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
  const [memberNextCursor, setMemberNextCursor] = useState(props.initialMemberNextCursor);
  const [nextTeamCursor, setNextTeamCursor] = useState(props.initialNextTeamCursor);
  const [projectRoles, setProjectRoles] = useState(props.initialProjectRoles);
  const [projectRoleNextCursor, setProjectRoleNextCursor] = useState(props.initialProjectRoleNextCursor);
  const [feedback, setFeedback] = useState<Feedback>();
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [teamQuery, setTeamQuery] = useState("");
  const deferredTeamQuery = useDeferredValue(teamQuery);

  useEffect(() => {
    setTeams(props.teams);
    setTeam(props.selectedTeam);
    setTeamEtag(props.selectedTeamEtag);
    setMembers(props.initialMembers);
    setMemberNextCursor(props.initialMemberNextCursor);
    setNextTeamCursor(props.initialNextTeamCursor);
    setProjectRoles(props.initialProjectRoles);
    setProjectRoleNextCursor(props.initialProjectRoleNextCursor);
    setFeedback(undefined);
    setDeleteConfirmation("");
  }, [
    props.initialMemberNextCursor,
    props.initialMembers,
    props.initialNextTeamCursor,
    props.initialProjectRoles,
    props.initialProjectRoleNextCursor,
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
  const visibleTeams = useMemo(() => {
    const query = deferredTeamQuery.trim().toLocaleLowerCase("ko-KR");
    if (query === "") return teams;
    return teams.filter((item) => `${item.displayName} ${item.slug}`.toLocaleLowerCase("ko-KR").includes(query));
  }, [deferredTeamQuery, teams]);

  async function loadMoreTeams() {
    if (nextTeamCursor === null) return;
    await mutation.run(async () => {
      try {
        const result = await listTeams(createBrowserApiClient(), {
          organizationId: props.organization.id,
          pageSize: 100,
          cursor: nextTeamCursor
        });
        setTeams((current) => {
          const known = new Set(current.map((item) => item.id));
          return [...current, ...result.data.items.filter((item) => !known.has(item.id))];
        });
        setNextTeamCursor(result.data.nextCursor);
      } catch (cause) {
        setFeedback(teamFailure(cause));
      }
    });
  }

  async function loadMoreMembers() {
    if (team === undefined || memberNextCursor === null) return;
    await mutation.run(async () => {
      try {
        const result = await listTeamMembers(createBrowserApiClient(), {
          organizationId: props.organization.id,
          teamId: team.id,
          pageSize: 100,
          cursor: memberNextCursor
        });
        setMembers((current) => appendUnique(current, result.data.items, (item) => item.userId));
        setMemberNextCursor(result.data.nextCursor);
      } catch (cause) {
        setFeedback(teamFailure(cause));
      }
    });
  }

  async function loadMoreProjectRoles() {
    if (team === undefined || projectRoleNextCursor === null) return;
    await mutation.run(async () => {
      try {
        const result = await listTeamProjectRoles(createBrowserApiClient(), {
          organizationId: props.organization.id,
          teamId: team.id,
          pageSize: 100,
          cursor: projectRoleNextCursor
        });
        setProjectRoles((current) => appendUnique(current, result.data.items, (item) => item.projectId));
        setProjectRoleNextCursor(result.data.nextCursor);
      } catch (cause) {
        setFeedback(teamFailure(cause));
      }
    });
  }

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
      setFeedback({ message: "팀 이름을 저장했습니다.", reconcile: false, tone: "success" });
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
      setFeedback({ message: "팀 멤버를 추가했습니다.", reconcile: false, tone: "success" });
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
      setFeedback({ message: "팀 멤버 역할을 저장했습니다.", reconcile: false, tone: "success" });
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
      setFeedback({ message: "팀에서 멤버를 제외했습니다.", reconcile: false, tone: "success" });
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
      setFeedback({ message: "팀에 프로젝트 접근 권한을 부여했습니다.", reconcile: false, tone: "success" });
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
      setFeedback({ message: "팀의 프로젝트 역할을 저장했습니다.", reconcile: false, tone: "success" });
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
      setFeedback({ message: "팀의 프로젝트 접근 권한을 제거했습니다.", reconcile: false, tone: "success" });
    });
  }

  return (
    <main id="main-content" className="workspace-page team-page" tabIndex={-1}>
      <header className="workspace-page__intro">
        <p className="eyebrow">{props.organization.displayName}</p>
        <h1>팀과 프로젝트 권한</h1>
        <p>조직 멤버를 팀으로 구성하고 필요한 프로젝트와 역할만 연결하세요.</p>
      </header>

      <section className="product-metrics team-metrics" aria-label="팀 요약">
        <article><span>접근 가능한 팀</span><strong>{teams.length}</strong><small>현재 계정에서 확인할 수 있음</small></article>
        <article><span>선택한 팀 멤버</span><strong>{team === undefined ? "—" : members.length}</strong><small>유지관리자와 일반 멤버</small></article>
        <article><span>프로젝트 연결</span><strong>{team === undefined ? "—" : projectRoles.length}</strong><small>팀에 직접 부여된 역할</small></article>
      </section>

      <nav className="organization-tabs" aria-label="조직 설정">
        <Link href={`/organizations?organization=${props.organization.id}`}>조직 개요</Link>
        <Link href={teamHref(props.organization.id)} aria-current="page">팀과 권한</Link>
      </nav>

      <div className="team-layout">
        <aside className="team-sidebar" aria-label="팀 선택">
          {props.canCreateTeam ? (
            <form className="collaboration-form" onSubmit={handleCreate} aria-busy={mutation.isPending}>
              <h2>새 팀</h2>
              <label className="field-group">
                슬러그
                <input name="slug" required pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" maxLength={63} disabled={mutation.isPending} />
              </label>
              <label className="field-group">
                표시 이름
                <input name="displayName" required maxLength={200} disabled={mutation.isPending} />
              </label>
              <Button type="submit" variant="primary" disabled={mutation.isPending}>팀 만들기</Button>
            </form>
          ) : (
            <div className="team-access-note">
              <strong>조직 멤버 권한</strong>
              <p>소속된 팀을 확인할 수 있습니다. 팀 생성과 삭제는 조직 소유자만 할 수 있습니다.</p>
            </div>
          )}

          <nav aria-label="팀">
            <div className="team-directory-heading"><h2 className="team-sidebar__heading">팀 목록</h2><span>{visibleTeams.length} / {teams.length}</span></div>
            <label className="product-search team-search"><span aria-hidden="true">⌕</span><span className="sr-only">팀 검색</span><input value={teamQuery} onChange={(event) => setTeamQuery(event.currentTarget.value)} placeholder="팀 이름 또는 슬러그 검색" /></label>
            {nextTeamCursor !== null ? <p className="team-search-scope">현재 불러온 팀에서 검색합니다.</p> : null}
            {visibleTeams.length === 0 ? (
              <p className="team-empty-copy">{teams.length === 0 ? "사용 가능한 팀이 없습니다." : "검색 결과가 없습니다."}</p>
            ) : (
              <ul className="record-list team-list">
                {visibleTeams.map((item) => (
                  <li key={item.id}>
                    <Link href={teamHref(props.organization.id, item.id)} aria-current={team?.id === item.id ? "page" : undefined}>
                      <strong>{item.displayName}</strong>
                      <span>{item.slug}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {nextTeamCursor !== null ? (
              <Button type="button" size="sm" disabled={mutation.isPending} onClick={() => void loadMoreTeams()}>
                {mutation.isPending ? "불러오는 중…" : "팀 더 보기"}
              </Button>
            ) : null}
          </nav>
        </aside>

        <section className="team-detail" aria-labelledby="team-detail-title">
          {team === undefined ? (
            <div className="team-empty-state">
              <p className="eyebrow">팀 접근 권한</p>
              <h2 id="team-detail-title">팀을 선택하세요</h2>
              <p>팀을 선택하면 멤버와 프로젝트 역할을 함께 확인할 수 있습니다.</p>
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
                  {feedback.reconcile ? <Button type="button" size="sm" onClick={() => router.refresh()}>최신 팀 정보 불러오기</Button> : null}
                </div>
              )}

              <section className="team-section" aria-labelledby="team-profile-title">
                <div className="team-section__heading">
                  <div><h3 id="team-profile-title">팀 정보</h3><p>슬러그는 유지되며 표시 이름은 변경할 수 있습니다.</p></div>
                </div>
                {props.canRenameTeam ? (
                  <form className="team-inline-form" onSubmit={handleRename} aria-busy={mutation.isPending}>
                    <label className="field-group">표시 이름<input name="displayName" defaultValue={team.displayName} required maxLength={200} disabled={mutation.isPending} /></label>
                    <Button type="submit" disabled={mutation.isPending}>이름 저장</Button>
                  </form>
                ) : <p className="team-read-only">현재 팀 멤버십은 읽기 전용입니다.</p>}
              </section>

              <TeamMembers
                canManage={props.canManageMembers}
                currentUserId={props.currentUserId}
                disabled={mutation.isPending}
                memberById={memberById}
                memberOptions={memberOptions}
                members={members}
                hasMore={memberNextCursor !== null}
                onAdd={handleAddMember}
                onLoadMore={loadMoreMembers}
                onRemove={handleRemoveMember}
                onRoleChange={handleMemberRole}
              />

              <TeamProjectRoles
                canManage={props.canManageProjectRoles}
                disabled={mutation.isPending}
                grants={projectRoles}
                hasMore={projectRoleNextCursor !== null}
                onAdd={handleAddProjectRole}
                onLoadMore={loadMoreProjectRoles}
                onRemove={handleRemoveProjectRole}
                onRoleChange={handleProjectRole}
                projectById={projectById}
                projectOptions={projectOptions}
              />

              {props.canDeleteTeam ? (
                <section className="team-section team-danger-zone" aria-labelledby="team-delete-title">
                  <div className="team-section__heading"><div><h3 id="team-delete-title">팀 삭제</h3><p>팀, 멤버십과 프로젝트 역할을 제거합니다. 프로젝트 자체는 삭제되지 않습니다.</p></div></div>
                  <label className="field-group">확인하려면 <strong>{team.slug}</strong> 입력<input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.currentTarget.value)} autoComplete="off" spellCheck={false} disabled={mutation.isPending} /></label>
                  <Button type="button" variant="danger" disabled={mutation.isPending || deleteConfirmation !== team.slug} onClick={() => void handleDelete()}>팀 삭제</Button>
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
  readonly hasMore: boolean;
  readonly onAdd: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly onLoadMore: () => Promise<void>;
  readonly onRemove: (member: TeamMember) => Promise<void>;
  readonly onRoleChange: (member: TeamMember, role: TeamRole) => Promise<void>;
}

function TeamMembers(props: TeamMembersProps) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const visibleMembers = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLocaleLowerCase("ko-KR");
    if (normalizedQuery === "") return props.members;
    return props.members.filter((member) => {
      const organizationMember = props.memberById.get(member.userId);
      return `${organizationMember?.displayName ?? ""} ${member.role} ${member.userId}`
        .toLocaleLowerCase("ko-KR")
        .includes(normalizedQuery);
    });
  }, [deferredQuery, props.memberById, props.members]);

  return (
    <section className="team-section" aria-labelledby="team-members-title">
      <div className="team-section__heading"><div><h3 id="team-members-title">멤버</h3><p>유지관리자는 팀 멤버를 관리하고 일반 멤버는 팀 리소스를 조회합니다.</p></div><span>{visibleMembers.length} / {props.members.length}</span></div>
      {props.canManage ? (
        <form className="team-add-form" onSubmit={props.onAdd} aria-busy={props.disabled}>
          <SelectField id="team-member-user" label="조직 멤버" name="userId" required disabled={props.disabled || props.memberOptions.length === 0} placeholder="멤버 선택" options={props.memberOptions.map((member) => ({ value: member.userId, label: `${member.displayName} · 조직 ${organizationRoleLabel(member.organizationRole)} · ${shortId(member.userId)}` }))} />
          <SelectField id="team-member-new-role" label="팀 역할" name="role" defaultValue="member" disabled={props.disabled} options={[{ value: "member", label: "멤버" }, { value: "maintainer", label: "유지관리자" }]} />
          <Button type="submit" disabled={props.disabled || props.memberOptions.length === 0}>멤버 추가</Button>
        </form>
      ) : null}
      {props.members.length > 0 ? <label className="product-search team-search"><span aria-hidden="true">⌕</span><span className="sr-only">팀 멤버 검색</span><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="멤버 이름, 역할 또는 식별자 검색" /></label> : null}
      {props.hasMore ? <p className="team-search-scope">현재 불러온 멤버에서 검색합니다.</p> : null}
      {props.members.length === 0 ? <p className="team-empty-copy">이 팀에는 아직 멤버가 없습니다.</p> : visibleMembers.length === 0 ? <p className="team-empty-copy">검색 결과가 없습니다.</p> : (
        <ul className="record-list team-records" aria-busy={query !== deferredQuery} aria-label="팀 멤버">
          {visibleMembers.map((member, index) => {
            const organizationMember = props.memberById.get(member.userId);
            const label = organizationMember?.displayName ?? `확인할 수 없는 멤버 ${index + 1}`;
            return <li key={member.userId}><div><strong>{label}{member.userId === props.currentUserId ? " (나)" : ""}</strong><span>조직 {organizationMember === undefined ? "멤버십 정보 없음" : organizationRoleLabel(organizationMember.organizationRole)}</span></div>{props.canManage ? <div className="record-actions"><SelectField id={`team-member-role-${member.userId}`} label={`${label} 역할`} labelHidden density="compact" value={member.role} disabled={props.disabled} options={[{ value: "member", label: "멤버" }, { value: "maintainer", label: "유지관리자" }]} onValueChange={(nextRole) => void props.onRoleChange(member, teamRole(nextRole))} /><Button type="button" size="sm" disabled={props.disabled || member.userId === props.currentUserId} aria-label={`${label} 팀에서 제외`} onClick={() => void props.onRemove(member)}>제외</Button></div> : <span className="team-role-badge">{teamRoleLabel(member.role)}</span>}</li>;
          })}
        </ul>
      )}
      {props.hasMore ? <Button type="button" size="sm" disabled={props.disabled} onClick={() => void props.onLoadMore()}>{props.disabled ? "불러오는 중…" : "멤버 더 보기"}</Button> : null}
    </section>
  );
}

interface TeamProjectRolesProps {
  readonly canManage: boolean;
  readonly disabled: boolean;
  readonly grants: readonly TeamProjectRole[];
  readonly hasMore: boolean;
  readonly onAdd: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly onLoadMore: () => Promise<void>;
  readonly onRemove: (grant: TeamProjectRole) => Promise<void>;
  readonly onRoleChange: (grant: TeamProjectRole, role: ProjectRole) => Promise<void>;
  readonly projectById: ReadonlyMap<string, ProjectOption>;
  readonly projectOptions: readonly ProjectOption[];
}

function TeamProjectRoles(props: TeamProjectRolesProps) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const visibleGrants = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLocaleLowerCase("ko-KR");
    if (normalizedQuery === "") return props.grants;
    return props.grants.filter((grant) => {
      const project = props.projectById.get(grant.projectId);
      return `${project?.name ?? ""} ${project?.slug ?? ""} ${grant.role} ${grant.projectId}`
        .toLocaleLowerCase("ko-KR")
        .includes(normalizedQuery);
    });
  }, [deferredQuery, props.grants, props.projectById]);

  return (
    <section className="team-section" aria-labelledby="team-projects-title">
      <div className="team-section__heading"><div><h3 id="team-projects-title">프로젝트 접근</h3><p>읽기는 조회, 쓰기는 콘텐츠 변경, 관리는 프로젝트 설정 변경 권한을 제공합니다.</p></div><span>{visibleGrants.length} / {props.grants.length}</span></div>
      {props.canManage ? (
        <form className="team-add-form" onSubmit={props.onAdd} aria-busy={props.disabled}>
          <SelectField id="team-project-new" label="프로젝트" name="projectId" required disabled={props.disabled || props.projectOptions.length === 0} placeholder="프로젝트 선택" options={props.projectOptions.map((project) => ({ value: project.id, label: `${project.name} · ${project.slug}` }))} />
          <SelectField id="team-project-new-role" label="프로젝트 역할" name="role" defaultValue="read" disabled={props.disabled} options={[{ value: "read", label: "읽기" }, { value: "write", label: "쓰기" }, { value: "admin", label: "관리" }]} />
          <Button type="submit" disabled={props.disabled || props.projectOptions.length === 0}>접근 권한 부여</Button>
        </form>
      ) : <p className="team-read-only">조직 소유자만 팀의 프로젝트 역할을 변경할 수 있습니다.</p>}
      {props.grants.length > 0 ? <label className="product-search team-search"><span aria-hidden="true">⌕</span><span className="sr-only">프로젝트 권한 검색</span><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="프로젝트 이름, 슬러그 또는 역할 검색" /></label> : null}
      {props.hasMore ? <p className="team-search-scope">현재 불러온 프로젝트 권한에서 검색합니다.</p> : null}
      {props.grants.length === 0 ? <p className="team-empty-copy">이 팀에 연결된 프로젝트가 없습니다.</p> : visibleGrants.length === 0 ? <p className="team-empty-copy">검색 결과가 없습니다.</p> : (
        <ul className="record-list team-records" aria-busy={query !== deferredQuery} aria-label="팀 프로젝트 역할">
          {visibleGrants.map((grant, index) => {
            const project = props.projectById.get(grant.projectId);
            const label = project?.name ?? `확인할 수 없는 프로젝트 ${index + 1}`;
            return <li key={grant.projectId}><div><strong>{label}</strong><span>{project?.slug ?? "프로젝트 정보 없음"}</span></div>{props.canManage ? <div className="record-actions"><SelectField id={`team-project-role-${grant.projectId}`} label={`${label} 역할`} labelHidden density="compact" value={grant.role} disabled={props.disabled} options={[{ value: "read", label: "읽기" }, { value: "write", label: "쓰기" }, { value: "admin", label: "관리" }]} onValueChange={(nextRole) => void props.onRoleChange(grant, projectRole(nextRole))} /><Button type="button" size="sm" disabled={props.disabled} aria-label={`${label} 접근 제거`} onClick={() => void props.onRemove(grant)}>제거</Button></div> : <span className="team-role-badge">{projectRoleLabel(grant.role)}</span>}</li>;
          })}
        </ul>
      )}
      {props.hasMore ? <Button type="button" size="sm" disabled={props.disabled} onClick={() => void props.onLoadMore()}>{props.disabled ? "불러오는 중…" : "프로젝트 권한 더 보기"}</Button> : null}
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

function appendUnique<T>(
  current: readonly T[],
  incoming: readonly T[],
  identity: (item: T) => string
): readonly T[] {
  const known = new Set(current.map(identity));
  return [...current, ...incoming.filter((item) => !known.has(identity(item)))];
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

function organizationRoleLabel(role: OrganizationMemberOption["organizationRole"]): string {
  return role === "owner" ? "소유자" : "멤버";
}

function teamRoleLabel(role: TeamRole): string {
  return role === "maintainer" ? "유지관리자" : "멤버";
}

function projectRoleLabel(role: ProjectRole): string {
  if (role === "admin") return "관리";
  if (role === "write") return "쓰기";
  return "읽기";
}

function teamFailure(cause: unknown): Feedback {
  if (cause instanceof ApiError) {
    if (cause.status === 403) return { message: "이 팀 작업을 수행할 권한이 없습니다.", reconcile: false, tone: "error" };
    if (cause.status === 412 || cause.status === 428 || cause.code === "COMMIT_OUTCOME_UNKNOWN") return { message: "팀 정보가 변경되었거나 서버 처리 결과를 확인할 수 없습니다. 최신 정보를 불러온 뒤 계속하세요.", reconcile: true, tone: "error" };
    if (cause.status === 409) return { message: "이미 사용 중인 값이거나 팀 정보가 변경되었습니다. 최신 상태를 확인하세요.", reconcile: true, tone: "error" };
    if (cause.status === 400 || cause.status === 422) return { message: "입력값이 올바르지 않습니다. 폼을 확인하고 다시 시도하세요.", reconcile: false, tone: "error" };
  }
  return { message: "팀 요청을 완료하지 못했습니다. 서비스 상태를 확인하고 다시 시도하세요.", reconcile: false, tone: "error" };
}
