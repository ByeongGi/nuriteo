import Link from "next/link";
import { tv } from "tailwind-variants";

import { AdminPage } from "#src/app/(admin)/admin/_components/admin-surface.tsx";
import { buttonVariants } from "#src/components/ui/button.styles.ts";

interface AdminAccessRequiredProps {
  readonly description: string;
}

const accessRequiredStyles = tv({
  slots: {
    panel: "grid max-w-2xl grid-cols-[3rem_minmax(0,1fr)] gap-4 rounded-xl border border-warning/30 bg-surface p-6 shadow-xs max-[32rem]:grid-cols-1",
    mark: "grid size-12 place-items-center rounded-full bg-warning-subtle text-xl text-warning",
    copy: "grid gap-3 [&_h1]:m-0 [&_h1]:text-2xl [&_p]:m-0 [&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-muted-foreground",
    eyebrow: "text-xs font-semibold uppercase tracking-[0.08em] text-warning"
  }
});

export function AdminAccessRequired({ description }: AdminAccessRequiredProps) {
  const styles = accessRequiredStyles();
  return (
    <AdminPage id="main-content" contentWidth="narrow" tabIndex={-1}>
      <section className={styles.panel()} aria-labelledby="admin-access-required-title">
        <span className={styles.mark()} aria-hidden="true">◇</span>
        <div className={styles.copy()}>
          <p className={styles.eyebrow()}>접근 제한</p>
          <h1 id="admin-access-required-title">관리자 권한이 필요합니다</h1>
          <p>{description}</p>
          <Link className={buttonVariants({ variant: "secondary" })} href="/workspaces">사용자 화면으로 돌아가기</Link>
        </div>
      </section>
    </AdminPage>
  );
}
