import { tv } from "tailwind-variants";

const accountLoadingStyles = tv({
  slots: {
    root: "grid gap-5" ,
    eyebrow: "h-3 w-20 animate-pulse rounded bg-raised",
    title: "h-9 w-48 animate-pulse rounded-md bg-raised",
    description: "h-4 w-full max-w-xl animate-pulse rounded bg-raised",
    grid: "grid overflow-hidden rounded-lg border border-muted-border pt-3",
    item: "h-[4.75rem] animate-pulse border-t border-muted-border bg-raised first:border-t-0"
  }
});

export default function AccountLoading() {
  const styles = accountLoadingStyles();
  return (
    <main id="main-content" className={styles.root()} aria-busy="true">
      <span className="sr-only" aria-live="polite">계정 설정을 불러오는 중</span>
      <span className={styles.eyebrow()} aria-hidden="true" />
      <span className={styles.title()} aria-hidden="true" />
      <span className={styles.description()} aria-hidden="true" />
      <div className={styles.grid()} aria-hidden="true">
        <span className={styles.item()} />
        <span className={styles.item()} />
        <span className={styles.item()} />
        <span className={styles.item()} />
      </div>
    </main>
  );
}

