"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import { tv } from "tailwind-variants";

const collapsibleStyles = tv({
  slots: {
    root: "min-w-0 rounded-lg border border-border bg-surface",
    trigger: "group flex min-h-10 w-full items-center justify-between gap-3 rounded-lg px-4 py-2.5 text-left text-sm font-semibold text-foreground outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
    indicator: "text-muted-foreground transition-transform duration-fast group-data-[panel-open]:rotate-180 motion-reduce:transition-none",
    panel: "h-[var(--collapsible-panel-height)] overflow-hidden text-sm text-muted-foreground transition-[height] duration-normal data-[ending-style]:h-0 data-[starting-style]:h-0 motion-reduce:transition-none",
    content: "border-t border-border px-4 py-3"
  }
});

function CollapsibleRoot({ className, ...props }: Collapsible.Root.Props) {
  const styles = collapsibleStyles();
  return (
    <Collapsible.Root
      data-slot="collapsible"
      className={typeof className === "function" ? (state) => styles.root({ className: className(state) }) : styles.root({ className })}
      {...props}
    />
  );
}

function CollapsibleTrigger({ className, ...props }: Collapsible.Trigger.Props) {
  const styles = collapsibleStyles();
  return (
    <Collapsible.Trigger
      data-slot="collapsible-trigger"
      className={typeof className === "function" ? (state) => styles.trigger({ className: className(state) }) : styles.trigger({ className })}
      {...props}
    />
  );
}

function CollapsibleIndicator({ className, ...props }: React.ComponentProps<"span">) {
  const styles = collapsibleStyles();
  return <span aria-hidden="true" data-slot="collapsible-indicator" className={styles.indicator({ className })} {...props} />;
}

function CollapsiblePanel({ className, ...props }: Collapsible.Panel.Props) {
  const styles = collapsibleStyles();
  return (
    <Collapsible.Panel
      data-slot="collapsible-panel"
      className={typeof className === "function" ? (state) => styles.panel({ className: className(state) }) : styles.panel({ className })}
      {...props}
    />
  );
}

function CollapsibleContent({ className, ...props }: React.ComponentProps<"div">) {
  const styles = collapsibleStyles();
  return <div data-slot="collapsible-content" className={styles.content({ className })} {...props} />;
}

export {
  CollapsibleContent,
  CollapsibleIndicator,
  CollapsiblePanel,
  CollapsibleRoot,
  CollapsibleTrigger,
  collapsibleStyles
};
