export default function ExamplesLoading() {
  return (
    <main id="main-content" className="mx-auto w-full max-w-[var(--n-layout-content-max)] px-[var(--n-layout-content-gutter)] py-12 md:py-20" tabIndex={-1}>
      <div className="loading-shell" aria-busy="true" aria-label="Loading public examples">
        <div className="loading-shell__line loading-shell__line--short" />
        <div className="loading-shell__line loading-shell__line--title" />
        <div className="loading-shell__grid">
          <div />
          <div />
          <div />
        </div>
      </div>
    </main>
  );
}
