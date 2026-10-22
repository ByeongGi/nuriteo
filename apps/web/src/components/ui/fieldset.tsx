"use client";

import { Fieldset } from "@base-ui/react/fieldset";
import { tv } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const fieldsetStyles = tv({
  slots: {
    root: "grid min-w-0 gap-4 border-0 p-0 disabled:opacity-60",
    legend: "mb-1 text-sm font-semibold text-foreground"
  }
});

function FieldsetRoot({ className, ...props }: Fieldset.Root.Props) {
  const styles = fieldsetStyles();
  return <Fieldset.Root data-slot="fieldset" className={resolveComponentClassName(className, (override) => styles.root({ className: override }))} {...props} />;
}

function FieldsetLegend({ className, ...props }: Fieldset.Legend.Props) {
  const styles = fieldsetStyles();
  return <Fieldset.Legend data-slot="fieldset-legend" className={resolveComponentClassName(className, (override) => styles.legend({ className: override }))} {...props} />;
}

export { FieldsetLegend, FieldsetRoot, fieldsetStyles };
