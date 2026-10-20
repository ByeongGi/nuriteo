"use client";

import Link from "next/link";

import { Button } from "../../components/ui/button.tsx";
import { ProductEntryShell } from "./product-entry-shell.tsx";

interface ErrorViewProps {
  onRetry: () => void;
  reference?: string | undefined;
}

export function ErrorView({ onRetry, reference }: ErrorViewProps) {
  return (
    <ProductEntryShell
      description="작업 내용은 변경되지 않았습니다. 페이지를 다시 시도하거나 홈으로 돌아가세요."
      eyebrow="문제가 발생했습니다"
      title="이 페이지를 안전하게 불러오지 못했습니다"
      titleId="error-title"
    >
      <div role="alert">
        {reference ? <p className="boundary-reference">Reference: {reference}</p> : null}
        <div className="boundary-actions">
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
          <Link className="text-link" href="/">
            Return home
          </Link>
        </div>
      </div>
    </ProductEntryShell>
  );
}
