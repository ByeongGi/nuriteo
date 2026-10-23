"use client";

import { ErrorView } from "#src/app/_components/error-view.tsx";

export default function MfaError({ reset }: { readonly reset: () => void }) {
  return <ErrorView homeHref="/sign-in" homeLabel="다시 로그인하기" onRetry={reset} />;
}
