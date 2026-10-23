import Link from "next/link";
import type { Metadata } from "next";
import { tv } from "tailwind-variants";

import { PageHeader } from "#src/components/ui/page-header.tsx";
import { AdminPage, AdminPanel } from "#src/app/(admin)/admin/_components/admin-surface.tsx";

export const metadata: Metadata = { title: "사용자 세션" };

const styles = tv({
  slots: {
    status: "w-fit rounded-full border border-muted-border bg-subtle px-3 py-1 text-xs font-semibold text-muted-foreground",
    copy: "m-0 max-w-3xl text-sm leading-6 text-muted-foreground",
    link: "w-fit font-semibold text-link no-underline hover:text-foreground"
  }
});

export default function AdminSessionsPage() {
  const css = styles();
  return <AdminPage id="main-content" tabIndex={-1}>
    <PageHeader eyebrow="사용자·접근" title="사용자 세션" description="인스턴스 전역 세션 관리 기능의 제공 범위와 안전한 접근 복구 경로를 확인합니다." />
    <AdminPanel className="grid gap-4" aria-labelledby="session-boundary-title">
      <span className={css.status()}>읽기 전용 안내</span>
      <h2 id="session-boundary-title">전역 세션 인벤토리는 아직 제공되지 않습니다</h2>
      <p className={css.copy()}>현재 서버에는 관리자가 모든 사용자의 활성 세션을 조회하거나 개별 세션을 선택해 폐기하는 API가 없습니다. 따라서 세션 수, 최근 접속 위치, 강제 로그아웃 버튼을 임의로 제공하지 않습니다.</p>
      <p className={css.copy()}>계정 탈취 대응이나 MFA 복구가 필요한 경우 검증된 사용자 MFA 초기화 흐름을 사용하세요. 이 작업은 선택한 사용자의 MFA 자격 증명과 활성 세션을 함께 폐기합니다.</p>
      <Link className={css.link()} href="/admin/access/mfa-reset">사용자 MFA 초기화로 이동 →</Link>
    </AdminPanel>
  </AdminPage>;
}
