import type { PublicPublishedExample } from "@nuriteo/api-client";
import Link from "next/link";

import { formatPublishedDate } from "../_utils/format-published-date.ts";
import type { PreviewOriginConfiguration } from "../../../runtime/preview-origin-contract.ts";
import { ForkExampleForm } from "./fork-example-form.tsx";
import { PublishedExamplePreview } from "./published-example-preview.tsx";

interface ReadOnlyExampleShellProps {
  readonly example: PublicPublishedExample;
  readonly previewConfiguration: PreviewOriginConfiguration;
}

export function ReadOnlyExampleShell({ example, previewConfiguration }: ReadOnlyExampleShellProps) {
  const bundleHref = `/api/v1/published-examples/${example.publicId}/versions/${example.versionNumber}/content`;
  return (
    <main id="main-content" className="min-h-[calc(100vh-var(--n-layout-header-height))] bg-background" tabIndex={-1}>
      <div className="mx-auto w-full max-w-[var(--n-layout-content-max)] px-[var(--n-layout-content-gutter)] py-6">
        <nav aria-label="Example navigation" className="mb-4 text-sm text-muted-foreground">
          <Link className="text-link underline-offset-4 hover:underline" href="/examples">
            Examples
          </Link>
          <span aria-hidden="true"> / </span>
          <Link
            className="text-link underline-offset-4 hover:underline"
            href={`/examples/${example.publicId}`}
          >
            {example.name}
          </Link>
          <span aria-hidden="true"> / Version {example.versionNumber}</span>
        </nav>

        <section className="overflow-hidden rounded-xl border border-muted-border bg-surface shadow-[var(--n-shadow-overlay)]" aria-labelledby="example-shell-title">
          <header className="flex flex-wrap items-center justify-between gap-4 border-b border-muted-border bg-raised px-5 py-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-selected px-2.5 py-1 text-xs font-semibold text-foreground">
                  Read-only
                </span>
                <span className="text-xs text-subtle-foreground">Fixed snapshot</span>
              </div>
              <h1 id="example-shell-title" className="mt-2 truncate text-lg font-medium tracking-[-0.02em] text-foreground">
                {example.name}
              </h1>
            </div>
            <dl className="grid grid-cols-2 gap-x-5 gap-y-1 text-xs">
              <dt className="text-subtle-foreground">Version</dt>
              <dd className="m-0 text-right font-mono text-foreground">{example.versionNumber}</dd>
              <dt className="text-subtle-foreground">Published</dt>
              <dd className="m-0 text-right text-foreground">{formatPublishedDate(example.publishedAt)}</dd>
            </dl>
          </header>

          <div className="grid min-h-[28rem] md:grid-cols-[15rem_minmax(0,1fr)]">
            <aside className="border-b border-muted-border bg-sidebar p-4 md:border-r md:border-b-0" aria-label="Snapshot information">
              <p className="m-0 text-xs font-semibold uppercase tracking-[0.08em] text-subtle-foreground">
                Snapshot
              </p>
              <p className="mt-3 text-sm text-muted-foreground">
                This public view is pinned to version {example.versionNumber}. It never follows a newer active version.
              </p>
              <p className="mt-4 break-all font-mono text-xs text-subtle-foreground">
                {example.publicId}
              </p>
            </aside>

            <div className="grid place-items-center p-6 md:p-10">
              <div className="w-full max-w-5xl text-center">
                <span className="mx-auto grid size-12 place-items-center rounded-xl border border-border bg-subtle text-xl text-primary" aria-hidden="true">
                  ◇
                </span>
                <h2 className="mt-5 text-2xl font-medium tracking-[-0.03em] text-foreground text-balance">
                  This published version is ready to browse.
                </h2>
                <p className="mt-3 text-muted-foreground text-balance">
                  A verified, sanitized archive is available through the public, cookie-free content boundary. It contains only this immutable snapshot and never includes project access, Git, account, or environment data.
                </p>
                <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                  <a
                    className="inline-flex min-h-10 items-center rounded-md bg-primary px-4 text-sm font-semibold text-on-primary no-underline transition-colors hover:bg-primary-strong"
                    download="nuriteo-published-example.tar"
                    href={bundleHref}
                  >
                    Download sanitized archive
                  </a>
                  <Link
                    className="inline-flex min-h-10 items-center rounded-md border border-border bg-subtle px-4 text-sm font-medium text-foreground no-underline transition-colors hover:bg-hover"
                    href={`/examples/${example.publicId}`}
                  >
                    Back to example details
                  </Link>
                </div>
                <div className="mx-auto mt-8 max-w-md">
                  <ForkExampleForm example={example} />
                </div>
                <PublishedExamplePreview
                  example={example}
                  previewConfiguration={previewConfiguration}
                />
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
