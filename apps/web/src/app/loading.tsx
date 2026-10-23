import { LoadingShell } from "#src/components/ui/loading-shell.tsx";

export default function Loading() {
  return (
    <main id="main-content" className="mx-auto w-[min(100%,var(--n-layout-content-max))] px-[var(--n-layout-content-gutter)] py-[clamp(3rem,8vw,7rem)]" aria-busy="true" aria-live="polite">
      <LoadingShell label="워크스페이스를 불러오는 중" showBodyLine />
    </main>
  );
}
