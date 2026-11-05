"use client";

import type { OrganizationInvitation, OrganizationMember } from "@nuriteo/api-client";
import Link from "next/link";
import { tv } from "tailwind-variants";

import { useOrganizationConsole } from "@/app/(authenticated)/organizations/_hooks/use-organization.ts";
import { Button } from "@/components/ui/button.tsx";
import { SelectField, TextField } from "@/components/ui/field.tsx";
import { MetricGrid, MetricItem } from "@/components/ui/metric-grid.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { SearchField } from "@/components/ui/search-field.tsx";

import type { OrganizationConsoleProps } from "@/app/(authenticated)/organizations/_hooks/use-organization.ts";

export type { OrganizationConsoleProps };

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

export function OrganizationConsole(props: OrganizationConsoleProps) {
  const context = props.context ?? "standalone";
  const inWorkspace = context === "workspace";
  const inCreation = context === "creation";
  const styles = organizationStyles({ context });
  const {
    activeWorkspace,
    changeRole,
    create,
    deferredMemberQuery,
    deliveryNotice,
    dismissInvitationLink,
    error,
    invitationFilter,
    invite,
    isPending,
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
  } = useOrganizationConsole(props);

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
          onValueChange={switchOrganization}
        />
        <Link className={styles.switcherLink()} href="/workspaces/new/organization" aria-current={(function () {
    if (!props.organization) {
        return ("page");
    }
    return (undefined);
})()}>새 조직</Link>
      </div>}
      {props.organization && !inWorkspace ? (
        <nav className={styles.actions()} aria-label={`${props.organization.displayName} 설정`}>
          <Link className={styles.actionLink()} href={(function () {
    if (activeWorkspace === undefined) {
        return ("/workspaces");
    }
    return (`/workspaces/${encodeURIComponent(activeWorkspace.storageScopeId)}/teams`);
})()}>팀과 권한 관리</Link>
        </nav>
      ) : null}
      {oneTimeUrl ? (
        <section className={styles.notice()} aria-labelledby="organization-invitation-link-title" aria-live="polite">
          <h2 id="organization-invitation-link-title">지금 초대 링크를 복사하세요</h2>
          <p>이 일회용 링크는 페이지를 떠나거나 새로 고치면 다시 표시되지 않습니다.</p>
          <output aria-labelledby="organization-invitation-link-title">{oneTimeUrl}</output>
          <Button type="button" onClick={dismissInvitationLink}>링크 확인 완료</Button>
        </section>
      ) : null}
      {deliveryNotice ? <p className={styles.status()} role="status">{deliveryNotice}</p> : null}
      {error ? <p className={styles.error()} role="alert">{error}</p> : null}
      {!props.organization ? (
        <form className={`${styles.form()} ${styles.createForm()}`} onSubmit={create} aria-busy={isPending}>
          <div><p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground">새 워크스페이스</p><h2>팀 워크스페이스 설정</h2><p>워크스페이스를 만들면 멤버를 초대하고 프로젝트 접근을 함께 관리할 수 있습니다.</p></div>
          <TextField label="워크스페이스 주소" description="영문 소문자, 숫자와 하이픈만 사용할 수 있습니다." name="slug" placeholder="nuriteo-team" required pattern="[a-z0-9][a-z0-9\\-]*" maxLength={63} disabled={isPending} />
          <TextField label="워크스페이스 이름" name="displayName" placeholder="누리터 팀" required maxLength={200} disabled={isPending} />
          <Button type="submit" variant="primary" disabled={isPending}>워크스페이스 만들기</Button>
        </form>
      ) : null}
      {props.organization ? (
        <>
        {(function () {
    if (inWorkspace) {
        return (null);
    }
    return (<MetricGrid className={styles.metrics()} aria-label="조직 지표">
          <MetricItem label="멤버" value={props.members?.length ?? 0} description={`소유자 ${props.members?.filter((member) => member.role === "owner").length ?? 0}명`} />
          <MetricItem label="대기 중 초대" value={props.invitations?.filter((invitation) => invitation.status === "pending").length ?? 0} description="아직 참여하지 않은 계정" />
          <MetricItem label="조직 버전" value={`v${props.organization.version}`} description={(function () {
    if (props.organization.status === "active") {
        return ("정상 운영 중");
    }
    return (props.organization.status);
})()} />
        </MetricGrid>);
})()}
        <section className={styles.management()}>
          {(function () {
    if (inWorkspace) {
        return (null);
    }
    return (<div className={styles.managementCard()}>
            <h2>{props.organization.displayName}</h2>
            <p>{(function () {
    if (props.organization.status === "active") {
        return ("활성 조직");
    }
    return (props.organization.status);
})()} · 버전 {props.organization.version}</p>
            {(function () {
    if (props.canManage) {
        return ((
              <form className={styles.form()} onSubmit={rename} aria-busy={isPending}>
                <TextField label="조직 이름" name="displayName" defaultValue={props.organization.displayName} required disabled={isPending} />
                <Button type="submit" disabled={isPending}>이름 저장</Button>
              </form>
            ));
    }
    return (<p>멤버 권한에서는 조직 정보를 조회할 수만 있습니다.</p>);
})()}
          </div>);
})()}
          <OrganizationMemberDirectory
            canManage={props.canManage}
            currentUserId={props.currentUserId}
            disabled={isPending}
            isFiltering={memberQuery !== deferredMemberQuery}
            members={visibleMembers}
            onQueryChange={setMemberQuery}
            onRemove={remove}
            onRoleChange={changeRole}
            query={memberQuery}
            totalCount={props.members?.length ?? 0}
          />
          {(function () {
    if (props.canManage) {
        return ((
            <div className={styles.managementCard()}>
              <h2>멤버 초대</h2>
              <form className={styles.form()} onSubmit={invite} aria-busy={isPending}>
                <TextField label="초대할 이메일" name="email" type="text" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} aria-describedby="organization-invitation-email-help" required disabled={isPending} />
                <p id="organization-invitation-email-help">기존 누리터 계정에 사용하는 이메일을 입력하세요.</p>
                <SelectField label="역할" name="role" options={[{ value: "member", label: "멤버" }, { value: "owner", label: "소유자" }]} defaultValue="member" required disabled={isPending} />
                <Button type="submit" variant="primary" disabled={isPending}>초대 발급</Button>
              </form>
              <OrganizationInvitationDirectory
                disabled={isPending}
                filter={invitationFilter}
                invitations={visibleInvitations}
                onFilterChange={setInvitationFilter}
                onReissue={reissue}
                onRevoke={revoke}
                totalCount={props.invitations?.length ?? 0}
              />
            </div>
          ));
    }
    return (null);
})()}
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
              <div><strong>{member.displayName}{(function () {
    if (member.userId === props.currentUserId) {
        return (" (나)");
    }
    return ("");
})()}</strong><span>{(function () {
    if (member.role === "owner") {
        return ("소유자");
    }
    return ("멤버");
})()} · {shortId(member.userId)}</span></div>
              {(function () {
    if (props.canManage && member.userId !== props.currentUserId) {
        return ((
                <div className={styles.recordActions()}>
                  <Button type="button" disabled={props.disabled} onClick={() => void props.onRoleChange(member)}>{(function () {
    if (member.role === "owner") {
        return ("멤버로 변경");
    }
    return ("소유자로 변경");
})()}</Button>
                  <Button type="button" disabled={props.disabled} onClick={() => void props.onRemove(member)}>제외</Button>
                </div>
              ));
    }
    return (null);
})()}
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
              <div><strong>{(function () {
    if (invitation.proposedRole === "owner") {
        return ("소유자 초대");
    }
    return ("멤버 초대");
})()} · {shortId(invitation.inviteeUserId)}</strong><span>{invitationStatusLabel(invitation.status)} · {expirationLabel(invitation.expiresAt)}</span></div>
              {(function () {
    if (invitation.status === "pending") {
        return ((
                <div className={styles.recordActions()}>
                  <Button type="button" disabled={props.disabled} onClick={() => void props.onReissue(invitation)}>다시 발급</Button>
                  <Button type="button" disabled={props.disabled} onClick={() => void props.onRevoke(invitation)}>취소</Button>
                </div>
              ));
    }
    return (null);
})()}
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
