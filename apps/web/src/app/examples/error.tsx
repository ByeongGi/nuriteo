"use client";

import { ErrorView } from "#src/app/_components/error-view.tsx";

export default function ExamplesError({ reset }: { readonly reset: () => void }) {
  return <ErrorView homeHref="/examples" homeLabel="공개 예제로 돌아가기" onRetry={reset} />;
}
