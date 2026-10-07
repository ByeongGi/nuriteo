export default function TeamsLoading() {
  return (
    <main id="main-content" className="workspace-page" aria-busy="true" aria-label="Loading Teams">
      <div className="loading-shell__line loading-shell__line--short" />
      <div className="loading-shell__line loading-shell__line--title" />
      <div className="team-loading-grid" aria-hidden="true">
        <div />
        <div />
      </div>
    </main>
  );
}
