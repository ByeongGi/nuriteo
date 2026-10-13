"use client";

import Link from "next/link";

import { Button } from "../../components/ui/button.tsx";

interface ErrorViewProps {
  onRetry: () => void;
  reference?: string | undefined;
}

export function ErrorView({ onRetry, reference }: ErrorViewProps) {
  return (
    <main id="main-content" className="boundary-page" tabIndex={-1}>
      <div className="boundary-card" role="alert" aria-labelledby="error-title">
        <p className="eyebrow">Something went wrong</p>
        <h1 id="error-title">This page could not be loaded safely.</h1>
        <p>Your work has not been changed. Try the page again or return home.</p>
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
    </main>
  );
}
