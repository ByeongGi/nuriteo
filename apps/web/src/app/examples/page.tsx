import { listPublicPublishedExamples } from "@nuriteo/api-client";
import type { Metadata } from "next";

import { EntryUnavailable } from "../_components/entry-unavailable.tsx";
import { safeRequestReference } from "../../lib/api/presentation-error.ts";
import { createPublicServerApiClient } from "../../lib/api/public-server-client.ts";
import { ExampleCard } from "./_components/example-card.tsx";

export const metadata: Metadata = {
  description: "Browse fixed, read-only examples published from this NURITEO instance.",
  title: "Examples"
};

export default async function ExamplesPage() {
  try {
    const result = await listPublicPublishedExamples(createPublicServerApiClient(), { limit: 48 });
    const examples = result.data.items;

    return (
      <main id="main-content" className="mx-auto w-full max-w-[var(--n-layout-content-max)] px-[var(--n-layout-content-gutter)] py-12 md:py-20" tabIndex={-1}>
        <header className="max-w-3xl">
          <p className="eyebrow">Published examples</p>
          <h1 className="m-0 text-4xl font-medium tracking-[-0.045em] text-foreground text-balance md:text-6xl">
            Explore what people are building.
          </h1>
          <p className="mt-5 max-w-2xl text-base text-muted-foreground md:text-lg">
            Every example is an immutable, read-only project version. Opening one never grants access to its source project or workspace.
          </p>
        </header>

        {examples.length === 0 ? (
          <section className="mt-12 rounded-xl border border-dashed border-border bg-subtle px-6 py-16 text-center" aria-labelledby="empty-examples-title">
            <h2 id="empty-examples-title" className="m-0 text-xl font-medium text-foreground">No public examples yet</h2>
            <p className="mt-2 text-muted-foreground">Published examples will appear here when they are made public.</p>
          </section>
        ) : (
          <section className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Public examples">
            {examples.map((example) => <ExampleCard key={example.publicId} example={example} />)}
          </section>
        )}
      </main>
    );
  } catch (error) {
    return (
      <EntryUnavailable
        description="Public examples could not be loaded safely. No sign-in or private project data was requested."
        reference={safeRequestReference(error)}
        retryHref="/examples"
        title="Examples are temporarily unavailable"
      />
    );
  }
}
