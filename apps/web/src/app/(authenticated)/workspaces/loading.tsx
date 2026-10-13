export default function WorkspacesLoading() {
  return (
    <main id="main-content" className="workspace-page" aria-busy="true" aria-live="polite">
      <div className="loading-shell">
        <span className="loading-shell__line loading-shell__line--short" />
        <span className="loading-shell__line loading-shell__line--title" />
        <div className="loading-shell__grid" aria-hidden="true">
          <div />
          <div />
        </div>
        <span className="sr-only">Loading Workspaces</span>
      </div>
    </main>
  );
}
