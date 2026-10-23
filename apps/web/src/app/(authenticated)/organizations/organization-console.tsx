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
import { useDeferredValue, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { tv } from "tailwind-variants";

import { Button } from "#src/components/ui/button.tsx";
import { SelectField, TextField } from "#src/components/ui/field.tsx";
import { MetricGrid, MetricItem } from "#src/components/ui/metric-grid.tsx";
import { PageHeader } from "#src/components/ui/page-header.tsx";
import { SearchField } from "#src/components/ui/search-field.tsx";
import {
  collaborationError,
  readCsrfCredential
} from "#src/lib/api/browser-security.ts";
import type { CollaborationOperation } from "#src/lib/api/browser-security.ts";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

const organizationStyles = tv({
  slots: {
    root: "mx-auto grid w-full max-w-none gap-4 px-6 py-6 max-[48rem]:px-4 max-[48rem]:py-4",
    switcher: "flex items-end justify-between gap-3 max-[48rem]:items-stretch max-[48rem]:flex-col [&_[data-slot=field]]:w-full sm:[&_[data-slot=field]]:max-w-md",
    switcherLink: "inline-flex min-h-9 shrink-0 items-center justify-center rounded-md border border-muted-border px-3 text-xs font-semibold text-foreground no-underline hover:bg-hover",
    actions: "flex justify-end",
    actionLink: "inline-flex min-h-9 items-center rounded-md border border-muted-border px-3 text-xs font-semibold text-foreground no-underline hover:bg-hover",
    notice: "grid gap-3 rounded-lg border border-warning bg-surface p-4 [&_h2]:m-0 [&_h2]:text-base [&_p]:m-0 [&_p]:text-sm [&_p]:text-muted-foreground [&_output]:select-all [&_output]:[overflow-wrap:anywhere] [&_output]:rounded-md [&_output]:bg-subtle [&_output]:p-3 [&_output]:font-mono",
    status: "m-0 rounded-lg border border-muted-border bg-surface px-4 py-3 text-sm",
    error: "m-0 rounded-lg border border-danger bg-danger-subtle px-4 py-3 text-sm text-danger",
    form: "grid gap-4 rounded-lg border border-muted-border bg-surface p-4",
    createForm: "grid max-w-3xl items-end gap-4 rounded-lg p-4 md:grid-cols-2 [&>div:first-child]:col-span-full [&_h2]:m-0 [&_p]:m-0 [&_p:last-child]:mt-2 [&_p:last-child]:text-sm [&_p:last-child]:leading-relaxed [&_p:last-child]:text-muted-foreground [&_[data-slot=button]]:justify-self-start [&_[data-slot=button]]:whitespace-nowrap",
    metrics: "[&_[data-slot=metric-item]]:min-h-20 [&_[data-slot=metric-item]]:rounded-lg [&_[data-slot=metric-item]]:p-3 [&_[data-slot=metric-item]>strong]:mt-1 [&_[data-slot=metric-item]>strong]:text-xl",
    management: "grid items-start gap-4 md:grid-cols-[minmax(16rem,.65fr)_minmax(0,1.35fr)] [&>div]:min-w-0 [&>div]:rounded-lg [&>div]:border [&>div]:border-muted-border [&>div]:bg-surface [&>div]:p-4 md:[&>div:last-child]:col-span-full",
    managementCard: "grid content-start gap-4 [&>h2]:m-0 [&>p]:m-0 [&>p]:text-sm [&>p]:text-muted-foreground",
    directory: "min-w-0",
    directoryHeading: "flex items-start justify-between gap-3 [&_h2]:m-0 [&_h3]:m-0 [&_h2]:text-base [&_h3]:text-sm [&_p]:mt-1 [&_p]:mb-0 [&_p]:text-sm [&_p]:text-muted-foreground",
    count: "shrink-0 rounded-full bg-subtle px-2 py-1 text-xs text-muted-foreground",
    search: "mt-3 w-full rounded-lg border border-muted-border bg-background px-3",
    empty: "mt-2 mb-0 text-sm text-muted-foreground",
    list: "mt-3 grid max-h-[36rem] list-none gap-0 overflow-auto overscroll-contain p-0 [scrollbar-gutter:stable]",
    record: "flex min-h-12 items-center justify-between gap-3 border-b border-muted-border py-2 max-[37.5rem]:items-stretch max-[37.5rem]:flex-col [&>div:first-child]:grid [&>div:first-child]:gap-0.5 [&_span]:text-xs [&_span]:text-muted-foreground",
    recordActions: "flex flex-wrap gap-3 max-[37.5rem]:[&>*]:w-full",
    invitations: "mt-4 border-t border-muted-border pt-4"
  },
  variants: {
    context: {
      standalone: {},
      creation: {
        root: "py-5",
        form: "shadow-none"
      },
      workspace: {
        management: "md:grid-cols-[minmax(0,1.15fr)_minmax(20rem,.85fr)] md:[&>div:last-child]:col-span-1"
      }
    }
  },
  defaultVariants: {
    context: "standalone"
  }
});

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

export function OrganizationConsole(props: OrganizationConsoleProps) {
  const context = props.context ?? "standalone";
  const inWorkspace = context === "workspace";
  const inCreation = context === "creation";
  const styles = organizationStyles({ context });
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
      const result = await createOrganization(
        createBrowserApiClient(),
        {
          slug: String(data.get("slug") ?? ""),
          displayName: String(data.get("displayName") ?? "")
        },
        { csrfToken: readCsrfCredential() }
      );
      router.replace("/workspaces");
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
        setDeliveryNotice("조직 초대 이메일을 전송 대기열에 추가했습니다.");
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
        setDeliveryNotice("새 초대 이메일을 전송 대기열에 추가했습니다.");
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

  let pageTitle = "조직";
  let pageDescription = "팀과 함께 개발할 조직 워크스페이스를 만들고 접근 권한을 관리하세요.";
  if (props.organization !== undefined) {
    pageTitle = inWorkspace ? "멤버" : "조직 관리";
    pageDescription = inWorkspace
      ? "워크스페이스 멤버와 초대 상태를 관리합니다."
      : "멤버, 팀, 초대와 조직 정보를 한곳에서 관리하세요.";
  }
  if (inCreation) {
    pageTitle = "팀 워크스페이스 만들기";
    pageDescription = "함께 프로젝트를 운영할 팀 이름과 워크스페이스 주소를 설정하세요.";
  }

  return (
    <main id="main-content" className={styles.root()}>
      <PageHeader
        density="compact"
        eyebrow={props.organization ? props.organization.displayName : "협업"}
        title={pageTitle}
        description={pageDescription}
      />
      {inWorkspace || inCreation ? null : <div className={styles.switcher()}>
        <SelectField
          id="organization-switcher-select"
          label="조직 전환"
          options={[
            { value: "create", label: "새 조직 만들기" },
            ...organizationWorkspaces.map((workspace) => ({ value: workspace.ownerId, label: workspace.displayLabel }))
          ]}
          value={props.organization?.id ?? "create"}
          onValueChange={(organizationId) => {
            const selected = organizationWorkspaces.find((workspace) => workspace.ownerId === organizationId);
            router.push(selected === undefined ? "/workspaces/new/organization" : `/workspaces/${encodeURIComponent(selected.storageScopeId)}/members`);
          }}
        />
        <Link className={styles.switcherLink()} href="/workspaces/new/organization" aria-current={!props.organization ? "page" : undefined}>새 조직</Link>
      </div>}
      {props.organization && !inWorkspace ? (
        <nav className={styles.actions()} aria-label={`${props.organization.displayName} 설정`}>
          <Link className={styles.actionLink()} href={activeWorkspace === undefined ? "/workspaces" : `/workspaces/${encodeURIComponent(activeWorkspace.storageScopeId)}/teams`}>팀과 권한 관리</Link>
        </nav>
      ) : null}
      {oneTimeUrl ? (
        <section className={styles.notice()} aria-labelledby="organization-invitation-link-title" aria-live="polite">
          <h2 id="organization-invitation-link-title">지금 초대 링크를 복사하세요</h2>
          <p>이 일회용 링크는 페이지를 떠나거나 새로 고치면 다시 표시되지 않습니다.</p>
          <output aria-labelledby="organization-invitation-link-title">{oneTimeUrl}</output>
          <Button type="button" onClick={() => { setOneTimeUrl(undefined); router.refresh(); }}>링크 확인 완료</Button>
        </section>
      ) : null}
      {deliveryNotice ? <p className={styles.status()} role="status">{deliveryNotice}</p> : null}
      {error ? <p className={styles.error()} role="alert">{error}</p> : null}
      {!props.organization ? (
        <form className={`${styles.form()} ${styles.createForm()}`} onSubmit={create} aria-busy={mutation.isPending}>
          <div><p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground">새 워크스페이스</p><h2>팀 워크스페이스 설정</h2><p>워크스페이스를 만들면 멤버를 초대하고 프로젝트 접근을 함께 관리할 수 있습니다.</p></div>
          <TextField label="워크스페이스 주소" description="영문 소문자, 숫자와 하이픈만 사용할 수 있습니다." name="slug" placeholder="nuriteo-team" required pattern="[a-z0-9][a-z0-9-]*" maxLength={63} disabled={mutation.isPending} />
          <TextField label="워크스페이스 이름" name="displayName" placeholder="누리터 팀" required maxLength={200} disabled={mutation.isPending} />
          <Button type="submit" variant="primary" disabled={mutation.isPending}>워크스페이스 만들기</Button>
        </form>
      ) : null}
      {props.organization ? (
        <>
        {inWorkspace ? null : <MetricGrid className={styles.metrics()} aria-label="조직 지표">
          <MetricItem label="멤버" value={props.members?.length ?? 0} description={`소유자 ${props.members?.filter((member) => member.role === "owner").length ?? 0}명`} />
          <MetricItem label="대기 중 초대" value={props.invitations?.filter((invitation) => invitation.status === "pending").length ?? 0} description="아직 참여하지 않은 계정" />
          <MetricItem label="조직 버전" value={`v${props.organization.version}`} description={props.organization.status === "active" ? "정상 운영 중" : props.organization.status} />
        </MetricGrid>}
        <section className={styles.management()}>
          {inWorkspace ? null : <div className={styles.managementCard()}>
            <h2>{props.organization.displayName}</h2>
            <p>{props.organization.status === "active" ? "활성 조직" : props.organization.status} · 버전 {props.organization.version}</p>
            {props.canManage ? (
              <form className={styles.form()} onSubmit={rename} aria-busy={mutation.isPending}>
                <TextField label="조직 이름" name="displayName" defaultValue={props.organization.displayName} required disabled={mutation.isPending} />
                <Button type="submit" disabled={mutation.isPending}>이름 저장</Button>
              </form>
            ) : <p>멤버 권한에서는 조직 정보를 조회할 수만 있습니다.</p>}
          </div>}
          <OrganizationMemberDirectory
            canManage={props.canManage}
            currentUserId={props.currentUserId}
            disabled={mutation.isPending}
            isFiltering={memberQuery !== deferredMemberQuery}
            members={visibleMembers}
            onQueryChange={setMemberQuery}
            onRemove={remove}
            onRoleChange={changeRole}
            query={memberQuery}
            totalCount={props.members?.length ?? 0}
          />
          {props.canManage ? (
            <div className={styles.managementCard()}>
              <h2>멤버 초대</h2>
              <form className={styles.form()} onSubmit={invite} aria-busy={mutation.isPending}>
                <TextField label="초대할 이메일" name="email" type="text" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} aria-describedby="organization-invitation-email-help" required disabled={mutation.isPending} />
                <p id="organization-invitation-email-help">기존 누리터 계정에 사용하는 이메일을 입력하세요.</p>
                <SelectField label="역할" name="role" options={[{ value: "member", label: "멤버" }, { value: "owner", label: "소유자" }]} defaultValue="member" required disabled={mutation.isPending} />
                <Button type="submit" variant="primary" disabled={mutation.isPending}>초대 발급</Button>
              </form>
              <OrganizationInvitationDirectory
                disabled={mutation.isPending}
                filter={invitationFilter}
                invitations={visibleInvitations}
                onFilterChange={setInvitationFilter}
                onReissue={reissue}
                onRevoke={(invitation) => mutate("organization-invitation-terminal", async () => {
                  await revokeOrganizationInvitation(
                    createBrowserApiClient(),
                    { organizationId: props.organization!.id, invitationId: invitation.id },
                    { csrfToken: readCsrfCredential() }
                  );
                })}
                totalCount={props.invitations?.length ?? 0}
              />
            </div>
          ) : null}
        </section>
        </>
      ) : null}
    </main>
  );
}

interface OrganizationMemberDirectoryProps {
  readonly canManage: boolean;
  readonly currentUserId: string;
  readonly disabled: boolean;
  readonly isFiltering: boolean;
  readonly members: readonly OrganizationMember[];
  readonly onQueryChange: (query: string) => void;
  readonly onRemove: (member: OrganizationMember) => Promise<void>;
  readonly onRoleChange: (member: OrganizationMember) => Promise<void>;
  readonly query: string;
  readonly totalCount: number;
}

function OrganizationMemberDirectory(props: OrganizationMemberDirectoryProps) {
  const styles = organizationStyles();
  return (
    <div className={styles.directory()}>
      <div className={styles.directoryHeading()}>
        <div><h2>멤버</h2><p>불러온 멤버의 이름, 역할 또는 식별자로 검색합니다.</p></div>
        <span className={styles.count()}>{props.members.length} / {props.totalCount}</span>
      </div>
      <SearchField className={styles.search()} density="compact" label="조직 멤버 검색" value={props.query} onChange={(event) => props.onQueryChange(event.currentTarget.value)} placeholder="이름 또는 역할 검색" />
      {props.members.length === 0 ? <p className={styles.empty()}>검색 결과가 없습니다.</p> : (
        <ul className={styles.list()} aria-busy={props.isFiltering} aria-label="조직 멤버">
          {props.members.map((member) => (
            <li className={styles.record()} key={member.userId}>
              <div><strong>{member.displayName}{member.userId === props.currentUserId ? " (나)" : ""}</strong><span>{member.role === "owner" ? "소유자" : "멤버"} · {shortId(member.userId)}</span></div>
              {props.canManage && member.userId !== props.currentUserId ? (
                <div className={styles.recordActions()}>
                  <Button type="button" disabled={props.disabled} onClick={() => void props.onRoleChange(member)}>{member.role === "owner" ? "멤버로 변경" : "소유자로 변경"}</Button>
                  <Button type="button" disabled={props.disabled} onClick={() => void props.onRemove(member)}>제외</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface OrganizationInvitationDirectoryProps {
  readonly disabled: boolean;
  readonly filter: "all" | "pending";
  readonly invitations: readonly OrganizationInvitation[];
  readonly onFilterChange: (filter: "all" | "pending") => void;
  readonly onReissue: (invitation: OrganizationInvitation) => Promise<void>;
  readonly onRevoke: (invitation: OrganizationInvitation) => Promise<void>;
  readonly totalCount: number;
}

function OrganizationInvitationDirectory(props: OrganizationInvitationDirectoryProps) {
  const styles = organizationStyles();
  return (
    <div className={styles.invitations()}>
      <div className={styles.directoryHeading()}>
        <h3>초대 내역</h3>
        <SelectField
          label="표시 범위"
          density="compact"
          options={[{ value: "pending", label: "대기 중" }, { value: "all", label: `전체 ${props.totalCount}` }]}
          value={props.filter}
          onValueChange={(nextValue) => props.onFilterChange(nextValue === "all" ? "all" : "pending")}
        />
      </div>
      {props.invitations.length === 0 ? <p className={styles.empty()}>표시할 초대가 없습니다.</p> : (
        <ul className={styles.list()} aria-label="조직 초대">
          {props.invitations.map((invitation) => (
            <li className={styles.record()} key={invitation.id}>
              <div><strong>{invitation.proposedRole === "owner" ? "소유자 초대" : "멤버 초대"} · {shortId(invitation.inviteeUserId)}</strong><span>{invitationStatusLabel(invitation.status)} · {expirationLabel(invitation.expiresAt)}</span></div>
              {invitation.status === "pending" ? (
                <div className={styles.recordActions()}>
                  <Button type="button" disabled={props.disabled} onClick={() => void props.onReissue(invitation)}>다시 발급</Button>
                  <Button type="button" disabled={props.disabled} onClick={() => void props.onRevoke(invitation)}>취소</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function expirationLabel(expiresAt: string): string {
  return `${new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(expiresAt))} 만료`;
}

function shortId(value: string): string {
  return value.slice(-8);
}

function invitationStatusLabel(status: OrganizationInvitation["status"]): string {
  if (status === "pending") return "전달 대기";
  if (status === "accepted") return "수락됨";
  if (status === "declined") return "거절됨";
  if (status === "revoked") return "취소됨";
  if (status === "superseded") return "교체됨";
  return "만료됨";
}
