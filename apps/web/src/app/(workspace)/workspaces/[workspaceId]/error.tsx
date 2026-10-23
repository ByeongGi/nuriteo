"use client";

import { ErrorView } from "#src/app/_components/error-view.tsx";

export default function WorkspaceError({ error, reset }: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  const reference = error.digest && /^[A-Za-z0-9_-]{1,128}$/u.test(error.digest) ? error.digest : undefined;
  return <ErrorView homeHref="/workspaces" homeLabel="워크스페이스 목록으로" onRetry={reset} reference={reference} />;
}
