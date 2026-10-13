import { ApiError, getPublicPublishedExample } from "@nuriteo/api-client";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EntryUnavailable } from "../../_components/entry-unavailable.tsx";
import { safeRequestReference } from "../../../lib/api/presentation-error.ts";
import { createPublicServerApiClient } from "../../../lib/api/public-server-client.ts";
import { publicIdPathSegment } from "../../../lib/published-example-path.ts";
import { formatPublishedDate } from "../_utils/format-published-date.ts";

export const metadata: Metadata = { title: "Published example" };

interface Props {
  readonly params: Promise<{ readonly publicId: string }>;
}

export default async function ExampleDetailPage({ params }: Props) {
  const { publicId } = await params;
  if (publicIdPathSegment(publicId) === undefined) notFound();
  try {
    const { data: example } = await getPublicPublishedExample(createPublicServerApiClient(), { publicId });
    const versionHref = `/examples/${example.publicId}/versions/${example.versionNumber}`;

    return (
      <main id="main-content" className="mx-auto w-full max-w-5xl px-[var(--n-layout-content-gutter)] py-10 md:py-16" tabIndex={-1}>
        <nav aria-label="Example navigation" className="text-sm text-muted-foreground">
          <Link className="text-link underline-offset-4 hover:underline" href="/examples">Examples</Link>
          <span aria-hidden="true"> / {example.name}</span>
        </nav>

        <article className="mt-5 overflow-hidden rounded-xl border border-muted-border bg-surface shadow-[var(--n-shadow-overlay)]">
          <div className="border-b border-muted-border bg-raised px-6 py-8 md:px-10 md:py-12">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-selected px-2.5 py-1 text-xs font-semibold text-foreground">
                {example.visibility === "unlisted" ? "Unlisted" : "Public"}
              </span>
              <span className="text-xs text-subtle-foreground">Immutable version {example.versionNumber}</span>
            </div>
            <h1 className="mt-5 mb-0 text-4xl font-medium tracking-[-0.045em] text-foreground text-balance md:text-6xl">
              {example.name}
            </h1>
            <p className="mt-4 max-w-2xl text-base text-muted-foreground">
              Published {formatPublishedDate(example.publishedAt)}. This view exposes only the published snapshot metadata and never inherits access to the source project.
            </p>
            <Link
              className="mt-7 inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary no-underline transition-colors hover:bg-primary-strong"
              href={versionHref}
            >
              Open version {example.versionNumber}
              <span aria-hidden="true">→</span>
            </Link>
          </div>

          <dl className="grid gap-px bg-muted-border sm:grid-cols-3">
            <div className="bg-surface p-5">
              <dt className="text-xs text-subtle-foreground">Mode</dt>
              <dd className="mt-2 ml-0 font-medium text-foreground">Read-only</dd>
            </div>
            <div className="bg-surface p-5">
              <dt className="text-xs text-subtle-foreground">Version</dt>
              <dd className="mt-2 ml-0 font-mono text-foreground">{example.versionNumber}</dd>
            </div>
            <div className="bg-surface p-5">
              <dt className="text-xs text-subtle-foreground">Update behavior</dt>
              <dd className="mt-2 ml-0 font-medium text-foreground">Fixed snapshot</dd>
            </div>
          </dl>
        </article>
      </main>
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    return (
      <EntryUnavailable
        description="This published example could not be loaded safely. No private project data was requested."
        reference={safeRequestReference(error)}
        retryHref={`/examples/${encodeURIComponent(publicId)}`}
        title="Example is temporarily unavailable"
      />
    );
  }
}
