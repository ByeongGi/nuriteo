export default function Loading() {
  return (
    <main id="main-content" className="shell-main" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading workspace</span>
      <div className="loading-shell" aria-hidden="true">
        <div className="loading-shell__line loading-shell__line--short" />
        <div className="loading-shell__line loading-shell__line--title" />
        <div className="loading-shell__line" />
        <div className="loading-shell__grid">
          <div />
          <div />
          <div />
        </div>
      </div>
    </main>
  );
}
