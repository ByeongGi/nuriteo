"use client";

import { ErrorView } from "#src/app/_components/error-view.tsx";

export default function SignInError({ reset }: { readonly reset: () => void }) {
  return <ErrorView homeHref="/sign-in" homeLabel="로그인 다시 열기" onRetry={reset} />;
}
