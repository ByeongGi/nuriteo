import type { ReactNode } from "react";
import { tv } from "tailwind-variants";

import { PageHeader } from "#src/components/ui/page-header.tsx";

const styles = tv({
  slots: {
    root: "mx-auto grid w-full max-w-[82rem] gap-6 px-[clamp(1.25rem,4vw,3.5rem)] py-6 max-[48rem]:px-4",
    panel: "grid gap-4 rounded-xl border border-muted-border bg-surface p-5 shadow-xs [&>p]:m-0 [&>p]:text-sm [&>p]:leading-relaxed [&>p]:text-muted-foreground",
    notice: "flex items-start justify-between gap-4 rounded-lg border border-info/25 bg-info-subtle px-4 py-3 text-sm leading-relaxed text-info max-[36rem]:flex-col [&_p]:m-0",
    facts: "grid gap-px overflow-hidden rounded-lg border border-muted-border bg-muted-border sm:grid-cols-2",
    fact: "grid gap-1 bg-surface p-4 [&_dt]:text-xs [&_dt]:font-medium [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:break-words [&_dd]:text-sm [&_dd]:font-semibold"
  }
});

export function ProjectSettingsSection({ children, description, projectName, title }: Readonly<{ children: ReactNode; description: string; projectName: string; title: string }>) {
  const css = styles();
  return (
    <main id="main-content" className={css.root()} tabIndex={-1}>
      <PageHeader eyebrow={projectName} title={title} description={description} />
      {children}
    </main>
  );
}

export function ProjectSettingsPanel({ children }: Readonly<{ children: ReactNode }>) {
  return <section className={styles().panel()}>{children}</section>;
}

export function ProjectFacts({ items }: Readonly<{ items: readonly { label: string; value: ReactNode }[] }>) {
  const css = styles();
  return <dl className={css.facts()}>{items.map((item) => <div className={css.fact()} key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>;
}

export function ProjectSettingsNotice({ children }: Readonly<{ children: ReactNode }>) {
  return <aside className={styles().notice()}>{children}</aside>;
}
