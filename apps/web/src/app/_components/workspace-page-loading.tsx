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
    <main id="main-content" className="mx-auto w-full max-w-[64rem] px-[var(--n-layout-content-gutter)] py-[clamp(2rem,7vw,5rem)]" aria-busy="true" aria-live="polite">
      <LoadingShell cardCount={cardCount} label={label} showBodyLine />
    </main>
  );
}
