import Link from "next/link";
import type { Metadata } from "next";
import { tv } from "tailwind-variants";

import { PageHeader } from "#src/components/ui/page-header.tsx";
import { AdminPage, AdminPanel } from "#src/app/(admin)/admin/_components/admin-surface.tsx";

export const metadata: Metadata = { title: "사용자 디렉터리" };

const styles = tv({
  slots: {
    note: "m-0 max-w-3xl text-sm leading-6 text-muted-foreground",
    actions: "grid grid-cols-2 gap-3 max-[42rem]:grid-cols-1",
    action: "grid gap-1 rounded-lg border border-muted-border bg-subtle p-4 text-foreground no-underline hover:border-primary/35 hover:bg-hover",
    actionTitle: "font-semibold",
    actionCopy: "text-sm leading-5 text-muted-foreground"
  }
});

export default function AdminUsersPage() {
  const css = styles();
  return <AdminPage id="main-content" tabIndex={-1}>
    <PageHeader eyebrow="사용자·접근" title="사용자 디렉터리" description="계정 생성과 접근 복구에 필요한 관리자 작업을 한곳에서 시작합니다." />
    <AdminPanel className="grid gap-5" aria-labelledby="user-directory-boundary">
      <div>
        <h2 id="user-directory-boundary">현재 지원 범위</h2>
        <p className={css.note()}>전체 사용자 목록과 계정 상태 변경 API는 아직 제공되지 않습니다. 검색 결과나 계정 수를 추정해 표시하지 않고, 현재 지원되는 초대와 MFA 접근 복구 작업으로 연결합니다.</p>
      </div>
      <div className={css.actions()}>
        <Link className={css.action()} href="/admin/access/invitations"><span className={css.actionTitle()}>가입 초대 관리</span><span className={css.actionCopy()}>새 사용자를 초대하고 만료되거나 취소된 초대를 관리합니다.</span></Link>
        <Link className={css.action()} href="/admin/access/mfa-reset"><span className={css.actionTitle()}>사용자 MFA 초기화</span><span className={css.actionCopy()}>이메일 또는 표시 이름으로 대상을 확인한 뒤 MFA와 활성 세션을 초기화합니다.</span></Link>
      </div>
    </AdminPanel>
  </AdminPage>;
}
