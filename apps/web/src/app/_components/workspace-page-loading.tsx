import { LoadingShell } from "#src/components/ui/loading-shell.tsx";

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
      <LoadingShell cardCount={cardCount} label={label} showBodyLine />
    </main>
  );
}
