import { tv } from "tailwind-variants";

const accountLoadingStyles = tv({
  slots: {
    root: "grid gap-5" ,
    eyebrow: "h-3 w-20 animate-pulse rounded bg-raised",
    title: "h-9 w-48 animate-pulse rounded-md bg-raised",
    description: "h-4 w-full max-w-xl animate-pulse rounded bg-raised",
    grid: "grid gap-3 pt-3 sm:grid-cols-2",
    item: "h-36 animate-pulse rounded-xl bg-raised"
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

