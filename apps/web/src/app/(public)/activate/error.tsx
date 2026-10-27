"use client";

import { ErrorView } from "#src/app/_components/error-view.tsx";

export default function ActivationError({ reset }: { readonly reset: () => void }) {
  return <ErrorView homeHref="/sign-in" homeLabel="로그인으로 돌아가기" onRetry={reset} />;
}
