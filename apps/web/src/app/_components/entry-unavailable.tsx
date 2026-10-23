import { ServiceUnavailableState } from "#src/app/_components/system-state.tsx";

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
    <ServiceUnavailableState
      description={description}
      reference={reference}
      retryHref={retryHref}
      title={title}
    />
  );
}
