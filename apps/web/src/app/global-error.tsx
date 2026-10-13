"use client";

import { ErrorView } from "./_components/error-view.tsx";

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  const reference = error.digest && /^[A-Za-z0-9_-]{1,128}$/u.test(error.digest)
    ? error.digest
    : undefined;

  return (
    <html lang="en" data-theme-mode="system">
      <body>
        <ErrorView onRetry={reset} reference={reference} />
      </body>
    </html>
  );
}
