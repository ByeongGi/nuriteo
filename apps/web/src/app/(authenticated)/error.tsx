"use client";

import { ErrorView } from "#src/app/_components/error-view.tsx";

interface AuthenticatedErrorProps {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

export default function AuthenticatedError({ error, reset }: AuthenticatedErrorProps) {
  const reference = error.digest && /^[A-Za-z0-9_-]{1,128}$/u.test(error.digest)
    ? error.digest
    : undefined;
  return <ErrorView homeHref="/dashboard" homeLabel="대시보드로 돌아가기" onRetry={reset} reference={reference} />;
}
