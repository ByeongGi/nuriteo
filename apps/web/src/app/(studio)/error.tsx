"use client";

import { ErrorView } from "#src/app/_components/error-view.tsx";

interface StudioErrorProps {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

export default function StudioError({ error, reset }: StudioErrorProps) {
  const reference = error.digest && /^[A-Za-z0-9_-]{1,128}$/u.test(error.digest)
    ? error.digest
    : undefined;
  return <ErrorView homeHref="/workspaces" homeLabel="워크스페이스로 돌아가기" onRetry={reset} reference={reference} />;
}
