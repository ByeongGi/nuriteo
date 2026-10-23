import type { Metadata } from "next";
import Link from "next/link";
import { tv } from "tailwind-variants";

import { PageHeader } from "#src/components/ui/page-header.tsx";

export const metadata: Metadata = { title: "워크스페이스 추가" };

const workspaceCreationStyles = tv({
  slots: {
    root: "w-full px-6 py-5 outline-none max-[48rem]:px-4 max-[48rem]:py-4",
    grid: "mt-5 grid max-w-4xl gap-3 md:grid-cols-2",
    card: "grid min-h-44 content-between gap-4 rounded-lg border border-muted-border bg-surface p-4",
    copy: "grid content-start gap-2 [&_h2]:m-0 [&_h2]:text-lg [&_p]:m-0 [&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-muted-foreground",
    badge: "w-fit rounded-full bg-subtle px-2 py-1 text-xs font-semibold text-muted-foreground",
    action: "inline-flex min-h-8 items-center justify-center rounded-md border border-primary bg-primary px-3 text-xs font-semibold text-on-primary no-underline shadow-xs hover:bg-primary-strong",
    disabled: "inline-flex min-h-8 items-center justify-center rounded-md border border-muted-border bg-subtle px-3 text-xs font-semibold text-disabled-foreground"
  }
});

export default function NewWorkspacePage() {
  const styles = workspaceCreationStyles();

  return (
    <main id="main-content" className={styles.root()} tabIndex={-1}>
      <PageHeader
        density="compact"
        eyebrow="워크스페이스"
        title="새 작업 공간 추가"
        description="소유 형태를 먼저 선택하세요. 프로젝트와 멤버 권한은 선택한 워크스페이스 안에서 관리됩니다."
      />
      <section className={styles.grid()} aria-label="워크스페이스 유형">
        <article className={styles.card()}>
          <div className={styles.copy()}>
            <span className={styles.badge()}>개인</span>
            <h2>내 워크스페이스</h2>
            <p>개인 워크스페이스는 계정을 만들 때 자동으로 준비되며 별도로 여러 개 생성하지 않습니다.</p>
          </div>
          <span className={styles.disabled()} aria-disabled="true">이미 준비됨</span>
        </article>
        <article className={styles.card()}>
          <div className={styles.copy()}>
            <span className={styles.badge()}>공유</span>
            <h2>팀 워크스페이스</h2>
            <p>멤버, 팀, 역할을 함께 관리하는 공유 워크스페이스를 만듭니다. 생성 시 소유 조직 정보가 함께 설정됩니다.</p>
          </div>
          <Link className={styles.action()} href="/workspaces/new/organization">팀 워크스페이스 만들기</Link>
        </article>
      </section>
    </main>
  );
}
