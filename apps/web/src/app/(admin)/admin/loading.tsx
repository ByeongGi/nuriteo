import { tv } from "tailwind-variants";

import { AdminPage } from "#src/app/(admin)/admin/_components/admin-surface.tsx";

const loadingStyles = tv({
  slots: {
    header: "grid gap-3",
    eyebrow: "h-3 w-24 animate-pulse rounded-full bg-subtle motion-reduce:animate-none",
    title: "h-9 w-56 animate-pulse rounded-lg bg-subtle motion-reduce:animate-none",
    description: "h-4 w-full max-w-xl animate-pulse rounded-full bg-subtle motion-reduce:animate-none",
    grid: "grid gap-4 md:grid-cols-2 xl:grid-cols-3",
    card: "h-52 animate-pulse rounded-xl border border-muted-border bg-surface motion-reduce:animate-none"
  }
});

export default function AdminLoading() {
  const styles = loadingStyles();
  return (
    <AdminPage aria-busy="true" aria-live="polite" id="main-content">
      <span className="sr-only">관리자 화면을 불러오는 중</span>
      <header className={styles.header()} aria-hidden="true">
        <span className={styles.eyebrow()} />
        <span className={styles.title()} />
        <span className={styles.description()} />
      </header>
      <div className={styles.grid()} aria-hidden="true">
        <div className={styles.card()} /><div className={styles.card()} /><div className={styles.card()} />
      </div>
    </AdminPage>
  );
}
