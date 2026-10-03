export default function SetupLoading() {
  return (
    <main id="main-content" className="entry-page" aria-busy="true" aria-live="polite">
      <p className="sr-only">Checking setup status</p>
      <div className="entry-card entry-card--loading" aria-hidden="true">
        <div className="loading-shell__line loading-shell__line--short" />
        <div className="loading-shell__line loading-shell__line--title" />
        <div className="loading-shell__line" />
      </div>
    </main>
  );
}
