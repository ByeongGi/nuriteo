"use client";

import type { ComponentProps, ReactNode } from "react";
import { tv } from "tailwind-variants";
import type { VariantProps } from "tailwind-variants";

const pageHeaderStyles = tv({
  slots: {
    root: "flex flex-col gap-5 border-b border-muted-border pb-6 sm:flex-row sm:items-end sm:justify-between",
    copy: "grid min-w-0 max-w-3xl gap-2",
    eyebrow: "m-0 text-xs font-semibold tracking-[0.08em] text-accent-foreground",
    title: "m-0 text-3xl font-semibold leading-tight tracking-[-0.045em] text-foreground sm:text-4xl",
    description: "m-0 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base",
    aside: "flex shrink-0 flex-wrap items-center gap-2"
  },
  variants: {
    density: {
      comfortable: {},
      compact: {
        root: "gap-3 pb-4 sm:items-center",
        copy: "gap-1",
        eyebrow: "text-[var(--n-font-size-2xs)] tracking-[0.04em]",
        title: "text-xl tracking-[-0.025em] sm:text-xl",
        description: "text-sm leading-normal sm:text-sm"
      }
    }
  },
  defaultVariants: {
    density: "comfortable"
  }
});

interface PageHeaderProps extends Omit<ComponentProps<"header">, "title">, VariantProps<typeof pageHeaderStyles> {
  readonly actions?: ReactNode;
  readonly description: ReactNode;
  readonly eyebrow: ReactNode;
  readonly title: ReactNode;
}

function PageHeader({
  actions,
  className,
  density,
  description,
  eyebrow,
  title,
  ...props
}: PageHeaderProps) {
  const styles = pageHeaderStyles({ density });

  return (
    <header data-slot="page-header" className={styles.root({ className })} {...props}>
      <div data-slot="page-header-copy" className={styles.copy()}>
        <p data-slot="page-header-eyebrow" className={styles.eyebrow()}>{eyebrow}</p>
        <h1 data-slot="page-header-title" className={styles.title()}>{title}</h1>
        <p data-slot="page-header-description" className={styles.description()}>{description}</p>
      </div>
      {actions === undefined ? null : (
        <div data-slot="page-header-actions" className={styles.aside()}>{actions}</div>
      )}
    </header>
  );
}

export { PageHeader, pageHeaderStyles };
