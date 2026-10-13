import Link from "next/link";

interface EntryUnavailableProps {
  readonly description: string;
  readonly reference?: string | undefined;
  readonly retryHref: string;
  readonly title: string;
}

export function EntryUnavailable({
  description,
  reference,
  retryHref,
  title
}: EntryUnavailableProps) {
  return (
    <main id="main-content" className="entry-page" tabIndex={-1}>
      <section className="entry-card" aria-labelledby="entry-error-title">
        <p className="eyebrow">Connection required</p>
        <h1 id="entry-error-title">{title}</h1>
        <p className="entry-description">{description}</p>
        {reference ? <p className="entry-reference">Request reference: {reference}</p> : null}
        <Link className="link-button" href={retryHref}>
          Try again
        </Link>
      </section>
    </main>
  );
}
