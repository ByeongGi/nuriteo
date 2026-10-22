interface WorkspacePageLoadingProps {
  readonly cardCount?: number | undefined;
  readonly label: string;
}

export function WorkspacePageLoading({
  cardCount = 3,
  label
}: WorkspacePageLoadingProps) {
  return (
    <main id="main-content" className="workspace-page" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="loading-shell" aria-hidden="true">
        <span className="loading-shell__line loading-shell__line--short" />
        <span className="loading-shell__line loading-shell__line--title" />
        <span className="loading-shell__line" />
        <div className="loading-shell__grid">
          {Array.from({ length: cardCount }, (_, index) => <div key={index} />)}
        </div>
      </div>
    </main>
  );
}
