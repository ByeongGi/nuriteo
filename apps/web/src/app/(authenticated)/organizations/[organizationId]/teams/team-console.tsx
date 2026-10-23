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
import { tv } from "tailwind-variants";

import { Button } from "#src/components/ui/button.tsx";
import { SelectField, TextField } from "#src/components/ui/field.tsx";
import { MetricGrid, MetricItem } from "#src/components/ui/metric-grid.tsx";
import { PageHeader } from "#src/components/ui/page-header.tsx";
import { SearchField } from "#src/components/ui/search-field.tsx";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

const teamStyles = tv({
  slots: {
    root: "mx-auto grid w-full max-w-[64rem] gap-6 px-[clamp(1.25rem,4vw,3.5rem)] py-[clamp(2rem,7vw,5rem)] max-[48rem]:px-4 max-[48rem]:py-5",
    metrics: "mt-1",
    tabs: "flex flex-wrap gap-1 border-b border-muted-border pb-3",
    tab: "rounded-md px-3 py-2 text-sm font-medium text-link underline-offset-4 hover:bg-hover aria-[current=page]:bg-selected aria-[current=page]:text-foreground",
    layout: "grid min-w-0 content-start gap-6 md:grid-cols-[minmax(15rem,19rem)_minmax(0,1fr)]",
    sidebar: "grid min-w-0 content-start gap-6",
    form: "grid gap-4 rounded-lg border border-muted-border bg-surface p-4 [&_h2]:m-0 [&_h2]:text-base",
    accessNote: "rounded-xl border border-muted-border bg-surface p-4 [&_p]:mt-2 [&_p]:mb-0 [&_p]:text-sm [&_p]:text-muted-foreground",
    directoryHeading: "flex items-start justify-between gap-3 [&_h2]:m-0 [&_h2]:text-sm [&_h2]:font-semibold",
    count: "shrink-0 rounded-full bg-subtle px-2 py-1 text-xs text-muted-foreground",
    search: "my-3 w-full rounded-lg border border-muted-border bg-background px-3",
    searchScope: "-mt-2 mb-2 text-xs text-muted-foreground",
    emptyCopy: "mt-2 mb-0 text-sm text-muted-foreground",
    list: "m-0 grid max-h-[34rem] list-none gap-2 overflow-auto overscroll-contain p-0 [scrollbar-gutter:stable]",
    listItem: "m-0 p-0 [content-visibility:auto] [contain-intrinsic-size:auto_5rem]",
    listLink: "grid w-full gap-1 rounded-md p-3 text-foreground no-underline hover:bg-hover aria-[current=page]:bg-selected [&_span]:text-xs [&_span]:text-muted-foreground",
    detail: "grid min-w-0 content-start gap-6 rounded-xl border border-muted-border bg-surface p-[clamp(1rem,3vw,2rem)] [&_h2]:m-0 [&_h2]:text-xl [&_h2]:tracking-[-.025em] [&_h3]:mt-0 [&_h3]:mb-1 [&_h3]:text-base [&_p]:mt-0",
    emptyState: "grid min-w-0 content-start gap-2",
    detailHeader: "flex min-w-0 items-start justify-between gap-4 max-[37.5rem]:items-stretch max-[37.5rem]:flex-col",
    badge: "shrink-0 rounded-full bg-subtle px-2 py-1 text-xs font-medium text-muted-foreground",
    feedback: "flex items-center justify-between gap-3 rounded-md border border-muted-border bg-subtle p-3 max-[37.5rem]:items-stretch max-[37.5rem]:flex-col [&_p]:m-0",
    section: "grid min-w-0 content-start gap-4 border-t border-muted-border pt-6",
    sectionHeading: "flex min-w-0 items-start justify-between gap-4 max-[37.5rem]:items-stretch max-[37.5rem]:flex-col [&_p]:mb-0 [&_p]:text-sm [&_p]:text-muted-foreground",
    inlineForm: "grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]",
    addForm: "grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,.45fr)_auto]",
    readOnly: "mt-2 mb-0 text-sm text-muted-foreground",
    records: "m-0 grid max-h-[36rem] list-none gap-2 overflow-auto overscroll-contain p-0 [scrollbar-gutter:stable]",
    record: "flex items-center justify-between gap-3 border-b border-muted-border py-3 [content-visibility:auto] [contain-intrinsic-size:auto_5rem] max-[37.5rem]:items-stretch max-[37.5rem]:flex-col [&>div:first-child]:grid [&>div:first-child]:gap-1 [&_span]:text-xs [&_span]:text-muted-foreground",
    recordActions: "flex flex-wrap gap-3 max-[37.5rem]:[&>*]:w-full",
    danger: "border-t-danger [&_[data-slot=field]]:max-w-md [&_[data-slot=button]]:justify-self-start"
  },
  variants: {
    feedbackTone: {
      error: { feedback: "border-danger text-danger" },
      success: { feedback: "border-success" }
    }
  }
});

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
  readonly baseHref?: string;
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
  const styles = teamStyles();
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
      router.replace(teamHref(result.data.id, props.baseHref));
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
      router.replace(teamHref(undefined, props.baseHref));
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
    <main id="main-content" className={styles.root()} tabIndex={-1}>
      <PageHeader
        eyebrow={props.organization.displayName}
        title="팀과 프로젝트 권한"
        description="조직 멤버를 팀으로 구성하고 필요한 프로젝트와 역할만 연결하세요."
      />

      <MetricGrid className={styles.metrics()} aria-label="팀 요약">
        <MetricItem label="접근 가능한 팀" value={teams.length} description="현재 계정에서 확인 가능" />
        <MetricItem label="선택한 팀 멤버" value={team === undefined ? "—" : members.length} description="유지관리자와 일반 멤버" />
        <MetricItem label="프로젝트 연결" value={team === undefined ? "—" : projectRoles.length} description="팀에 직접 부여된 역할" />
      </MetricGrid>

      <nav className={styles.tabs()} aria-label="조직 설정">
        <Link className={styles.tab()} href={props.baseHref === undefined ? "/workspaces" : `${props.baseHref.replace(/\/teams$/u, "")}/members`}>조직 개요</Link>
        <Link className={styles.tab()} href={teamHref(undefined, props.baseHref)} aria-current="page">팀과 권한</Link>
      </nav>

      <div className={styles.layout()}>
        <aside className={styles.sidebar()} aria-label="팀 선택">
          {props.canCreateTeam ? (
            <form className={styles.form()} onSubmit={handleCreate} aria-busy={mutation.isPending}>
              <h2>새 팀</h2>
              <TextField label="슬러그" name="slug" required pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" maxLength={63} disabled={mutation.isPending} />
              <TextField label="표시 이름" name="displayName" required maxLength={200} disabled={mutation.isPending} />
              <Button type="submit" variant="primary" disabled={mutation.isPending}>팀 만들기</Button>
            </form>
          ) : (
            <div className={styles.accessNote()}>
              <strong>조직 멤버 권한</strong>
              <p>소속된 팀을 확인할 수 있습니다. 팀 생성과 삭제는 조직 소유자만 할 수 있습니다.</p>
            </div>
          )}

          <nav aria-label="팀">
            <div className={styles.directoryHeading()}><h2>팀 목록</h2><span className={styles.count()}>{visibleTeams.length} / {teams.length}</span></div>
            <SearchField className={styles.search()} label="팀 검색" value={teamQuery} onChange={(event) => setTeamQuery(event.currentTarget.value)} placeholder="팀 이름 또는 슬러그 검색" />
            {nextTeamCursor !== null ? <p className={styles.searchScope()}>현재 불러온 팀에서 검색합니다.</p> : null}
            {visibleTeams.length === 0 ? (
              <p className={styles.emptyCopy()}>{teams.length === 0 ? "사용 가능한 팀이 없습니다." : "검색 결과가 없습니다."}</p>
            ) : (
              <ul className={styles.list()}>
                {visibleTeams.map((item) => (
                  <li className={styles.listItem()} key={item.id}>
                    <Link className={styles.listLink()} href={teamHref(item.id, props.baseHref)} aria-current={team?.id === item.id ? "page" : undefined}>
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

        <section className={styles.detail()} aria-labelledby="team-detail-title">
          {team === undefined ? (
            <div className={styles.emptyState()}>
              <p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground">팀 접근 권한</p>
              <h2 id="team-detail-title">팀을 선택하세요</h2>
              <p>팀을 선택하면 멤버와 프로젝트 역할을 함께 확인할 수 있습니다.</p>
            </div>
          ) : (
            <>
              <header className={styles.detailHeader()}>
                <div>
                  <p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground">{team.slug}</p>
                  <h2 id="team-detail-title">{team.displayName}</h2>
                </div>
                <span className={styles.badge()} aria-label={`Team version ${team.version}`}>v{team.version}</span>
              </header>

              {feedback === undefined ? null : (
                <div className={teamStyles({ feedbackTone: feedback.tone }).feedback()} role={feedback.tone === "error" ? "alert" : "status"} aria-live="polite">
                  <p>{feedback.message}</p>
                  {feedback.reconcile ? <Button type="button" size="sm" onClick={() => router.refresh()}>최신 팀 정보 불러오기</Button> : null}
                </div>
              )}

              <section className={styles.section()} aria-labelledby="team-profile-title">
                <div className={styles.sectionHeading()}>
                  <div><h3 id="team-profile-title">팀 정보</h3><p>슬러그는 유지되며 표시 이름은 변경할 수 있습니다.</p></div>
                </div>
                {props.canRenameTeam ? (
                  <form className={styles.inlineForm()} onSubmit={handleRename} aria-busy={mutation.isPending}>
                    <TextField label="표시 이름" name="displayName" defaultValue={team.displayName} required maxLength={200} disabled={mutation.isPending} />
                    <Button type="submit" disabled={mutation.isPending}>이름 저장</Button>
                  </form>
                ) : <p className={styles.readOnly()}>현재 팀 멤버십은 읽기 전용입니다.</p>}
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
                <section className={`${styles.section()} ${styles.danger()}`} aria-labelledby="team-delete-title">
                  <div className={styles.sectionHeading()}><div><h3 id="team-delete-title">팀 삭제</h3><p>팀, 멤버십과 프로젝트 역할을 제거합니다. 프로젝트 자체는 삭제되지 않습니다.</p></div></div>
                  <TextField label={<>확인하려면 <strong>{team.slug}</strong> 입력</>} value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.currentTarget.value)} autoComplete="off" spellCheck={false} disabled={mutation.isPending} />
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
  const styles = teamStyles();
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
    <section className={styles.section()} aria-labelledby="team-members-title">
      <div className={styles.sectionHeading()}><div><h3 id="team-members-title">멤버</h3><p>유지관리자는 팀 멤버를 관리하고 일반 멤버는 팀 리소스를 조회합니다.</p></div><span className={styles.badge()}>{visibleMembers.length} / {props.members.length}</span></div>
      {props.canManage ? (
        <form className={styles.addForm()} onSubmit={props.onAdd} aria-busy={props.disabled}>
          <SelectField id="team-member-user" label="조직 멤버" name="userId" required disabled={props.disabled || props.memberOptions.length === 0} placeholder="멤버 선택" options={props.memberOptions.map((member) => ({ value: member.userId, label: `${member.displayName} · 조직 ${organizationRoleLabel(member.organizationRole)} · ${shortId(member.userId)}` }))} />
          <SelectField id="team-member-new-role" label="팀 역할" name="role" defaultValue="member" disabled={props.disabled} options={[{ value: "member", label: "멤버" }, { value: "maintainer", label: "유지관리자" }]} />
          <Button type="submit" disabled={props.disabled || props.memberOptions.length === 0}>멤버 추가</Button>
        </form>
      ) : null}
      {props.members.length > 0 ? <SearchField className={styles.search()} label="팀 멤버 검색" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="멤버 이름, 역할 또는 식별자 검색" /> : null}
      {props.hasMore ? <p className={styles.searchScope()}>현재 불러온 멤버에서 검색합니다.</p> : null}
      {props.members.length === 0 ? <p className={styles.emptyCopy()}>이 팀에는 아직 멤버가 없습니다.</p> : visibleMembers.length === 0 ? <p className={styles.emptyCopy()}>검색 결과가 없습니다.</p> : (
        <ul className={styles.records()} aria-busy={query !== deferredQuery} aria-label="팀 멤버">
          {visibleMembers.map((member, index) => {
            const organizationMember = props.memberById.get(member.userId);
            const label = organizationMember?.displayName ?? `확인할 수 없는 멤버 ${index + 1}`;
            return <li className={styles.record()} key={member.userId}><div><strong>{label}{member.userId === props.currentUserId ? " (나)" : ""}</strong><span>조직 {organizationMember === undefined ? "멤버십 정보 없음" : organizationRoleLabel(organizationMember.organizationRole)}</span></div>{props.canManage ? <div className={styles.recordActions()}><SelectField id={`team-member-role-${member.userId}`} label={`${label} 역할`} labelHidden density="compact" value={member.role} disabled={props.disabled} options={[{ value: "member", label: "멤버" }, { value: "maintainer", label: "유지관리자" }]} onValueChange={(nextRole) => void props.onRoleChange(member, teamRole(nextRole))} /><Button type="button" size="sm" disabled={props.disabled || member.userId === props.currentUserId} aria-label={`${label} 팀에서 제외`} onClick={() => void props.onRemove(member)}>제외</Button></div> : <span className={styles.badge()}>{teamRoleLabel(member.role)}</span>}</li>;
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
  const styles = teamStyles();
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
    <section className={styles.section()} aria-labelledby="team-projects-title">
      <div className={styles.sectionHeading()}><div><h3 id="team-projects-title">프로젝트 접근</h3><p>읽기는 조회, 쓰기는 콘텐츠 변경, 관리는 프로젝트 설정 변경 권한을 제공합니다.</p></div><span className={styles.badge()}>{visibleGrants.length} / {props.grants.length}</span></div>
      {props.canManage ? (
        <form className={styles.addForm()} onSubmit={props.onAdd} aria-busy={props.disabled}>
          <SelectField id="team-project-new" label="프로젝트" name="projectId" required disabled={props.disabled || props.projectOptions.length === 0} placeholder="프로젝트 선택" options={props.projectOptions.map((project) => ({ value: project.id, label: `${project.name} · ${project.slug}` }))} />
          <SelectField id="team-project-new-role" label="프로젝트 역할" name="role" defaultValue="read" disabled={props.disabled} options={[{ value: "read", label: "읽기" }, { value: "write", label: "쓰기" }, { value: "admin", label: "관리" }]} />
          <Button type="submit" disabled={props.disabled || props.projectOptions.length === 0}>접근 권한 부여</Button>
        </form>
      ) : <p className={styles.readOnly()}>조직 소유자만 팀의 프로젝트 역할을 변경할 수 있습니다.</p>}
      {props.grants.length > 0 ? <SearchField className={styles.search()} label="프로젝트 권한 검색" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="프로젝트 이름, 슬러그 또는 역할 검색" /> : null}
      {props.hasMore ? <p className={styles.searchScope()}>현재 불러온 프로젝트 권한에서 검색합니다.</p> : null}
      {props.grants.length === 0 ? <p className={styles.emptyCopy()}>이 팀에 연결된 프로젝트가 없습니다.</p> : visibleGrants.length === 0 ? <p className={styles.emptyCopy()}>검색 결과가 없습니다.</p> : (
        <ul className={styles.records()} aria-busy={query !== deferredQuery} aria-label="팀 프로젝트 역할">
          {visibleGrants.map((grant, index) => {
            const project = props.projectById.get(grant.projectId);
            const label = project?.name ?? `확인할 수 없는 프로젝트 ${index + 1}`;
            return <li className={styles.record()} key={grant.projectId}><div><strong>{label}</strong><span>{project?.slug ?? "프로젝트 정보 없음"}</span></div>{props.canManage ? <div className={styles.recordActions()}><SelectField id={`team-project-role-${grant.projectId}`} label={`${label} 역할`} labelHidden density="compact" value={grant.role} disabled={props.disabled} options={[{ value: "read", label: "읽기" }, { value: "write", label: "쓰기" }, { value: "admin", label: "관리" }]} onValueChange={(nextRole) => void props.onRoleChange(grant, projectRole(nextRole))} /><Button type="button" size="sm" disabled={props.disabled} aria-label={`${label} 접근 제거`} onClick={() => void props.onRemove(grant)}>제거</Button></div> : <span className={styles.badge()}>{projectRoleLabel(grant.role)}</span>}</li>;
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

function teamHref(teamId?: string, baseHref?: string): string {
  if (baseHref === undefined) return "/workspaces";
  return teamId === undefined ? baseHref : `${baseHref}/${encodeURIComponent(teamId)}`;
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
