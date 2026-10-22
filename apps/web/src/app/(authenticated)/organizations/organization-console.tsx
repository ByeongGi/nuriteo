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

import { Button } from "#src/components/ui/button.tsx";
import { SelectField } from "#src/components/ui/field.tsx";
import {
  collaborationError,
  readCsrfCredential
} from "#src/lib/api/browser-security.ts";
import type { CollaborationOperation } from "#src/lib/api/browser-security.ts";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { useExclusiveMutation } from "#src/lib/use-exclusive-mutation.ts";

export interface OrganizationConsoleProps {
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
  const [memberQuery, setMemberQuery] = useState("");
  const [invitationFilter, setInvitationFilter] = useState<"all" | "pending">("pending");
  const deferredMemberQuery = useDeferredValue(memberQuery);
  const organizationWorkspaces = useMemo(
    () => props.workspaces.filter((workspace) => workspace.ownerType === "organization"),
    [props.workspaces]
  );
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

  return (
    <main id="main-content" className="workspace-page organization-page">
      <header className="workspace-page__intro">
        <p className="eyebrow">{props.organization ? `${props.organization.displayName} / OVERVIEW` : "ORGANIZATION / COLLABORATION"}</p>
        <h1>{props.organization ? "조직 관리" : "조직"}</h1>
        <p>{props.organization ? "멤버, 팀, 초대와 조직 정보를 한곳에서 관리합니다." : "함께 개발할 조직 워크스페이스를 만들고 멤버와 권한을 관리합니다."}</p>
      </header>
      <div className="organization-switcher">
        <SelectField
          id="organization-switcher-select"
          label="조직 전환"
          options={[
            { value: "create", label: "새 조직 만들기" },
            ...organizationWorkspaces.map((workspace) => ({ value: workspace.ownerId, label: workspace.displayLabel }))
          ]}
          value={props.organization?.id ?? "create"}
          onValueChange={(organizationId) => {
            router.push(organizationId === "create" ? "/organizations" : `/organizations?organization=${organizationId}`);
          }}
        />
        <Link href="/organizations" aria-current={!props.organization ? "page" : undefined}>새 조직</Link>
      </div>
      {props.organization ? (
        <nav className="organization-actions" aria-label={`${props.organization.displayName} 설정`}>
          <Link href={`/organizations/${props.organization.id}/teams`}>팀과 권한 관리</Link>
        </nav>
      ) : null}
      {oneTimeUrl ? (
        <section className="one-time-panel" aria-labelledby="organization-invitation-link-title" aria-live="polite">
          <h2 id="organization-invitation-link-title">지금 초대 링크를 복사하세요</h2>
          <p>이 일회용 링크는 페이지를 떠나거나 새로 고치면 다시 표시되지 않습니다.</p>
          <output aria-labelledby="organization-invitation-link-title">{oneTimeUrl}</output>
          <Button type="button" onClick={() => { setOneTimeUrl(undefined); router.refresh(); }}>링크 확인 완료</Button>
        </section>
      ) : null}
      {deliveryNotice ? <p role="status">{deliveryNotice}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {!props.organization ? (
        <form className="collaboration-form organization-create-form" onSubmit={create} aria-busy={mutation.isPending}>
          <div><p className="eyebrow">새 워크스페이스</p><h2>새 조직 만들기</h2><p>조직을 만들면 멤버를 초대하고 프로젝트 접근을 함께 관리할 수 있습니다.</p></div>
          <label className="field-group">조직 주소<input name="slug" placeholder="nuriteo-team" required pattern="[a-z0-9][a-z0-9-]*" maxLength={63} disabled={mutation.isPending} /><small>영문 소문자, 숫자와 하이픈만 사용할 수 있습니다.</small></label>
          <label className="field-group">조직 이름<input name="displayName" placeholder="누리터 팀" required maxLength={200} disabled={mutation.isPending} /></label>
          <Button type="submit" variant="primary" disabled={mutation.isPending}>조직 만들기</Button>
        </form>
      ) : null}
      {props.organization ? (
        <>
        <section className="product-metrics organization-metrics" aria-label="조직 지표">
          <article><span>멤버</span><strong>{props.members?.length ?? 0}</strong><small>소유자 {props.members?.filter((member) => member.role === "owner").length ?? 0}명</small></article>
          <article><span>대기 중 초대</span><strong>{props.invitations?.filter((invitation) => invitation.status === "pending").length ?? 0}</strong><small>아직 참여하지 않은 계정</small></article>
          <article><span>조직 버전</span><strong>v{props.organization.version}</strong><small>{props.organization.status === "active" ? "정상 운영 중" : props.organization.status}</small></article>
        </section>
        <section className="collaboration-grid organization-management">
          <div>
            <h2>{props.organization.displayName}</h2>
            <p>{props.organization.status === "active" ? "활성 조직" : props.organization.status} · 버전 {props.organization.version}</p>
            {props.canManage ? (
              <form className="collaboration-form" onSubmit={rename} aria-busy={mutation.isPending}>
                <label className="field-group">조직 이름<input name="displayName" defaultValue={props.organization.displayName} required disabled={mutation.isPending} /></label>
                <Button type="submit" disabled={mutation.isPending}>이름 저장</Button>
              </form>
            ) : <p>멤버 권한에서는 조직 정보를 조회할 수만 있습니다.</p>}
          </div>
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
            <div>
              <h2>멤버 초대</h2>
              <form className="collaboration-form" onSubmit={invite} aria-busy={mutation.isPending}>
                <label className="field-group">초대할 이메일<input name="email" type="text" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} aria-describedby="organization-invitation-email-help" required disabled={mutation.isPending} /></label>
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
  return (
    <div className="organization-directory">
      <div className="organization-directory__heading">
        <div><h2>멤버</h2><p>불러온 멤버의 이름, 역할 또는 식별자로 검색합니다.</p></div>
        <span>{props.members.length} / {props.totalCount}</span>
      </div>
      <label className="product-search organization-search">
        <span aria-hidden="true">⌕</span>
        <span className="sr-only">조직 멤버 검색</span>
        <input
          value={props.query}
          onChange={(event) => props.onQueryChange(event.currentTarget.value)}
          placeholder="이름 또는 역할 검색"
        />
      </label>
      {props.members.length === 0 ? <p className="team-empty-copy">검색 결과가 없습니다.</p> : (
        <ul className="record-list organization-records" aria-busy={props.isFiltering} aria-label="조직 멤버">
          {props.members.map((member) => (
            <li key={member.userId}>
              <div><strong>{member.displayName}{member.userId === props.currentUserId ? " (나)" : ""}</strong><span>{member.role === "owner" ? "소유자" : "멤버"} · {shortId(member.userId)}</span></div>
              {props.canManage && member.userId !== props.currentUserId ? (
                <div className="record-actions">
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
  return (
    <div className="organization-invitations">
      <div className="organization-directory__heading">
        <h3>초대 내역</h3>
        <SelectField
          label="표시 범위"
          density="compact"
          options={[{ value: "pending", label: "대기 중" }, { value: "all", label: `전체 ${props.totalCount}` }]}
          value={props.filter}
          onValueChange={(nextValue) => props.onFilterChange(nextValue === "all" ? "all" : "pending")}
        />
      </div>
      {props.invitations.length === 0 ? <p className="team-empty-copy">표시할 초대가 없습니다.</p> : (
        <ul className="record-list organization-records" aria-label="조직 초대">
          {props.invitations.map((invitation) => (
            <li key={invitation.id}>
              <div><strong>{invitation.proposedRole === "owner" ? "소유자 초대" : "멤버 초대"} · {shortId(invitation.inviteeUserId)}</strong><span>{invitationStatusLabel(invitation.status)} · {expirationLabel(invitation.expiresAt)}</span></div>
              {invitation.status === "pending" ? (
                <div className="record-actions">
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
