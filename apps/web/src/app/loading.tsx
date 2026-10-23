import { LoadingShell } from "#src/components/ui/loading-shell.tsx";

export default function Loading() {
  return (
    <main id="main-content" className="shell-main" aria-busy="true" aria-live="polite">
      <LoadingShell label="워크스페이스를 불러오는 중" showBodyLine />
    </main>
  );
}
