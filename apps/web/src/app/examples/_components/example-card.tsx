import type { PublicPublishedExample } from "@nuriteo/api-client";
import Link from "next/link";

import { formatPublishedDate } from "../_utils/format-published-date.ts";

interface ExampleCardProps {
  readonly example: PublicPublishedExample;
}

export function ExampleCard({ example }: ExampleCardProps) {
  return (
    <article className="group grid min-h-56 content-between gap-8 rounded-xl border border-muted-border bg-surface p-5 transition-colors hover:border-border hover:bg-raised">
      <div>
        <div className="flex items-center justify-between gap-3">
          <span className="rounded-full bg-selected px-2.5 py-1 text-xs font-medium text-foreground">
            Version {example.versionNumber}
          </span>
          <span className="text-xs text-subtle-foreground">
            {formatPublishedDate(example.publishedAt)}
          </span>
        </div>
        <h2 className="mt-5 text-xl font-medium tracking-[-0.025em] text-foreground text-balance">
          {example.name}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          A fixed, read-only snapshot published for safe browsing.
        </p>
      </div>
      <Link
        className="inline-flex w-fit items-center gap-2 text-sm font-medium text-link underline-offset-4 group-hover:underline"
        href={`/examples/${example.publicId}`}
      >
        View example
        <span aria-hidden="true">→</span>
      </Link>
    </article>
  );
}
