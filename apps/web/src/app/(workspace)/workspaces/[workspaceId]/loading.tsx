import { tv } from "tailwind-variants";

const loadingStyles = tv({
  slots: {
    root: "mx-auto grid w-full max-w-none gap-4 px-6 py-6 max-[48rem]:px-4 max-[48rem]:py-4",
    line: "h-4 animate-pulse rounded-full bg-subtle motion-reduce:animate-none",
    title: "h-7 w-56 animate-pulse rounded-md bg-subtle motion-reduce:animate-none",
    panel: "h-64 animate-pulse rounded-lg border border-muted-border bg-surface motion-reduce:animate-none"
  }
});

export default function WorkspaceLoading() {
  const styles = loadingStyles();
  return <main className={styles.root()} id="main-content" aria-busy="true"><span className="sr-only">워크스페이스를 불러오는 중</span><span className={styles.line({ className: "w-28" })} /><span className={styles.title()} /><span className={styles.line({ className: "w-full max-w-xl" })} /><div className={styles.panel()} /></main>;
}
