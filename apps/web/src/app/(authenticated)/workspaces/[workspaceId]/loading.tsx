import { tv } from "tailwind-variants";

const loadingStyles = tv({
  slots: {
    root: "mx-auto grid w-full max-w-[82rem] gap-5 px-[clamp(1rem,4vw,3rem)] py-[clamp(1.5rem,4vw,3rem)]",
    line: "h-4 animate-pulse rounded-full bg-subtle motion-reduce:animate-none",
    title: "h-9 w-64 animate-pulse rounded-lg bg-subtle motion-reduce:animate-none",
    panel: "h-64 animate-pulse rounded-xl border border-muted-border bg-surface motion-reduce:animate-none"
  }
});

export default function WorkspaceLoading() {
  const styles = loadingStyles();
  return <main className={styles.root()} id="main-content" aria-busy="true"><span className="sr-only">워크스페이스를 불러오는 중</span><span className={styles.line({ className: "w-28" })} /><span className={styles.title()} /><span className={styles.line({ className: "w-full max-w-xl" })} /><div className={styles.panel()} /></main>;
}
