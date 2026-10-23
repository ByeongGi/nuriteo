import Link from "next/link";
import type { ReactNode } from "react";
import { tv } from "tailwind-variants";

import { PageHeader } from "#src/components/ui/page-header.tsx";

const sectionStyles = tv({
  slots: {
    root: "mx-auto grid w-full max-w-[82rem] gap-6 px-[clamp(1.25rem,4vw,3.5rem)] py-[clamp(2rem,4vw,3.75rem)] max-[48rem]:px-4 max-[48rem]:py-5",
    panel: "grid gap-4 rounded-xl border border-muted-border bg-surface p-5 shadow-xs",
    heading: "grid gap-1 [&_h2]:m-0 [&_h2]:text-base [&_p]:m-0 [&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-muted-foreground",
    facts: "grid gap-px overflow-hidden rounded-lg border border-muted-border bg-muted-border sm:grid-cols-2",
    fact: "grid gap-1 bg-surface p-4 [&_span]:text-xs [&_span]:font-medium [&_span]:text-muted-foreground [&_strong]:break-words [&_strong]:text-sm",
    action: "text-sm font-medium text-link underline-offset-4 hover:underline"
  }
});

interface Props {
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly description: string;
  readonly eyebrow: string;
  readonly title: string;
}

export function WorkspaceSection({ actions, children, description, eyebrow, title }: Props) {
  const styles = sectionStyles();
  return (
    <main id="main-content" className={styles.root()} tabIndex={-1}>
      <PageHeader eyebrow={eyebrow} title={title} description={description} actions={actions} />
      {children}
    </main>
  );
}

export function WorkspacePanel({ children, description, title }: Readonly<{ children: ReactNode; description: string; title: string }>) {
  const styles = sectionStyles();
  return <section className={styles.panel()}><div className={styles.heading()}><h2>{title}</h2><p>{description}</p></div>{children}</section>;
}

export function WorkspaceFacts({ items }: Readonly<{ items: readonly { label: string; value: ReactNode }[] }>) {
  const styles = sectionStyles();
  return <dl className={styles.facts()}>{items.map((item) => <div className={styles.fact()} key={item.label}><span>{item.label}</span><strong>{item.value}</strong></div>)}</dl>;
}

export function WorkspaceTextLink({ children, href }: Readonly<{ children: ReactNode; href: string }>) {
  return <Link className={sectionStyles().action()} href={href}>{children}</Link>;
}
