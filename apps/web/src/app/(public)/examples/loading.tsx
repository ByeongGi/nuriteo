import { examplesStyles } from "#src/app/(public)/examples/_components/examples.styles.ts";

export default function ExamplesLoading() {
  const styles = examplesStyles();
  return (
    <main id="main-content" className={styles.loadingPage()} tabIndex={-1}>
      <div className={styles.loading()} aria-busy="true" aria-label="공개 예제 불러오는 중">
        <div className={styles.loadingLine({ className: styles.loadingEyebrow() })} />
        <div className={styles.loadingLine({ className: styles.loadingTitle() })} />
        <div className={styles.loadingGrid()}>
          <div className={styles.loadingCard()} />
          <div className={styles.loadingCard()} />
          <div className={styles.loadingCard()} />
        </div>
      </div>
    </main>
  );
}
