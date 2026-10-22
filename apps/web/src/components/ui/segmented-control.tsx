"use client";

import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { ReactNode } from "react";
import { tv } from "tailwind-variants";
import type { VariantProps } from "tailwind-variants";

const segmentedControlStyles = tv({
  slots: {
    root: "flex min-w-0 gap-1 overflow-x-auto rounded-lg bg-subtle p-1",
    item: "min-h-8 shrink-0 rounded-md px-3 text-xs font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 focus-visible:ring-offset-subtle data-[pressed]:bg-surface data-[pressed]:font-semibold data-[pressed]:text-foreground data-[pressed]:shadow-xs motion-reduce:transition-none"
  },
  variants: {
    size: {
      compact: { item: "min-h-7 px-2.5" },
      default: {}
    },
    width: {
      auto: {},
      full: { root: "w-full", item: "flex-1" }
    }
  },
  defaultVariants: { size: "default", width: "auto" }
});

interface SegmentedControlOption<Value extends string> {
  readonly disabled?: boolean;
  readonly label: ReactNode;
  readonly value: Value;
}

interface SegmentedControlProps<Value extends string> extends VariantProps<typeof segmentedControlStyles> {
  readonly "aria-label": string;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly onValueChange: (value: Value) => void;
  readonly options: readonly SegmentedControlOption<Value>[];
  readonly value: Value;
}

function SegmentedControl<Value extends string>({
  "aria-label": ariaLabel,
  className,
  disabled,
  onValueChange,
  options,
  size,
  value,
  width
}: SegmentedControlProps<Value>) {
  const styles = segmentedControlStyles({ size, width });

  return (
    <ToggleGroup
      aria-label={ariaLabel}
      className={styles.root({ className })}
      disabled={disabled}
      value={[value]}
      onValueChange={(nextValues) => {
        const nextValue = nextValues[0];
        if (nextValue !== undefined) onValueChange(nextValue);
      }}
    >
      {options.map((option) => (
        <Toggle
          className={styles.item()}
          disabled={option.disabled}
          key={option.value}
          value={option.value}
        >
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

export { SegmentedControl, segmentedControlStyles };
export type { SegmentedControlOption, SegmentedControlProps };
