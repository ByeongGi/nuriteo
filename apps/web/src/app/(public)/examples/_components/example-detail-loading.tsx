import { examplesStyles } from "#src/app/(public)/examples/_components/examples.styles.ts";

export function ExampleDetailLoading({ version = false }: { readonly version?: boolean }) {
  const styles = examplesStyles();
  return (
    <main id="main-content" className={styles.loadingPage()} aria-busy="true" aria-label={version ? "예제 버전 불러오는 중" : "예제 상세 불러오는 중"}>
      <div className={styles.loading()} aria-hidden="true">
        <div className={styles.loadingLine({ className: styles.loadingEyebrow() })} />
        <div className={styles.loadingLine({ className: styles.loadingTitle() })} />
        <div className={styles.loadingLine({ className: "w-full max-w-2xl" })} />
        <div className={styles.loadingCard({ className: version ? "h-[32rem]" : "h-40" })} />
      </div>
    </main>
  );
}
