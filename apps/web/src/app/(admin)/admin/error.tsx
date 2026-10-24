"use client";

import { ErrorView } from "#src/app/_components/error-view.tsx";

export default function AdminError({ error, reset }: Readonly<{ error: Error & { digest?: string }; reset: () => void }>) {
  const reference = error.digest && /^[A-Za-z0-9_-]{1,128}$/u.test(error.digest) ? error.digest : undefined;
  return <ErrorView homeHref="/admin/operations" homeLabel="운영 현황으로" onRetry={reset} reference={reference} />;
}
