import Link from "next/link";

import { ProductEntryShell } from "./product-entry-shell.tsx";

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
    <ProductEntryShell
      description={description}
      eyebrow="연결 확인 필요"
      title={title}
      titleId="entry-error-title"
    >
        {reference ? <p className="entry-reference">Request reference: {reference}</p> : null}
        <Link className="link-button" href={retryHref}>
          Try again
        </Link>
    </ProductEntryShell>
  );
}
