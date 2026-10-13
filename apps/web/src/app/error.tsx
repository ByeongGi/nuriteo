"use client";

import { ErrorView } from "./_components/error-view.tsx";

interface ErrorBoundaryProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorBoundary({ error, reset }: ErrorBoundaryProps) {
  return <ErrorView onRetry={reset} reference={safeDigest(error.digest)} />;
}

function safeDigest(digest: string | undefined): string | undefined {
  return digest && /^[A-Za-z0-9_-]{1,128}$/u.test(digest) ? digest : undefined;
}
