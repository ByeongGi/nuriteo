import { tv } from "tailwind-variants";

const studioLoadingStyles = tv({
  slots: {
    page: "grid min-h-screen place-items-center bg-page p-5 text-foreground",
    card: "grid w-full max-w-md gap-4 rounded-xl border border-muted-border bg-surface p-6 shadow-sm",
    eyebrow: "m-0 text-xs font-semibold tracking-wide text-accent-foreground",
    title: "m-0 text-xl font-semibold tracking-tight",
    detail: "m-0 text-sm leading-relaxed text-muted-foreground",
    progress: "h-1.5 overflow-hidden rounded-full bg-subtle",
    indicator: "h-full w-1/3 animate-pulse rounded-full bg-primary motion-reduce:animate-none"
  }
});

export default function StudioLoading() {
  const styles = studioLoadingStyles();
  return (
    <main id="main-content" className={styles.page()} aria-busy="true" aria-live="polite">
      <section className={styles.card()}>
        <p className={styles.eyebrow()}>NURITEO STUDIO</p>
        <h1 className={styles.title()}>개발 환경을 준비하고 있습니다</h1>
        <p className={styles.detail()}>프로젝트와 브라우저 런타임 상태를 안전하게 확인하는 중입니다.</p>
        <div className={styles.progress()} aria-hidden="true"><div className={styles.indicator()} /></div>
      </section>
    </main>
  );
}
