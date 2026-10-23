"use client";

import type { ComponentProps, ReactNode } from "react";
import { tv } from "tailwind-variants";

const metricGridStyles = tv({
  slots: {
    root: "grid grid-cols-1 gap-3 sm:grid-cols-3",
    item: "grid min-h-28 content-between rounded-xl border border-muted-border bg-surface p-4 shadow-xs",
    label: "text-xs font-medium text-muted-foreground",
    value: "mt-3 text-3xl font-semibold tracking-[-0.04em] text-foreground",
    description: "mt-1 text-xs leading-relaxed text-subtle-foreground"
  }
});

function MetricGrid({ className, ...props }: ComponentProps<"section">) {
  const styles = metricGridStyles();
  return <section data-slot="metric-grid" className={styles.root({ className })} {...props} />;
}

interface MetricItemProps extends Omit<ComponentProps<"article">, "title"> {
  readonly description: ReactNode;
  readonly label: ReactNode;
  readonly value: ReactNode;
}

function MetricItem({ className, description, label, value, ...props }: MetricItemProps) {
  const styles = metricGridStyles();
  return (
    <article data-slot="metric-item" className={styles.item({ className })} {...props}>
      <span className={styles.label()}>{label}</span>
      <strong className={styles.value()}>{value}</strong>
      <small className={styles.description()}>{description}</small>
    </article>
  );
}

export { MetricGrid, MetricItem, metricGridStyles };
