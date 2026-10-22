"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import type { ReactNode } from "react";
import { tv } from "tailwind-variants";
import type { VariantProps } from "tailwind-variants";

const switchStyles = tv({
  slots: {
    root: "flex min-w-0 items-center justify-between gap-4 text-sm text-foreground has-[[data-disabled]]:opacity-50",
    copy: "grid min-w-0 gap-1",
    label: "font-medium leading-5",
    description: "text-xs leading-relaxed text-subtle-foreground",
    control:
      "relative h-6 w-10 shrink-0 cursor-pointer rounded-full bg-disabled outline-none transition-colors data-[checked]:bg-primary data-[disabled]:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    thumb: "absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow-xs transition-transform data-[checked]:translate-x-4 motion-reduce:transition-none"
  },
  variants: {
    appearance: {
      card: { root: "w-full rounded-md border border-muted-border bg-surface px-3 py-2.5" },
      plain: {}
    }
  },
  defaultVariants: { appearance: "plain" }
});

type SwitchFieldProps = Pick<SwitchPrimitive.Root.Props, "checked" | "defaultChecked" | "disabled" | "id" | "name" | "onCheckedChange" | "readOnly" | "required" | "value"> &
  VariantProps<typeof switchStyles> & {
    readonly description?: ReactNode;
    readonly label: ReactNode;
  };

function SwitchField({ appearance, description, label, ...props }: SwitchFieldProps) {
  const styles = switchStyles({ appearance });
  return (
    <label className={styles.root()}>
      <span className={styles.copy()}>
        <span className={styles.label()}>{label}</span>
        {description ? <span className={styles.description()}>{description}</span> : null}
      </span>
      <SwitchPrimitive.Root className={styles.control()} {...props}>
        <SwitchPrimitive.Thumb className={styles.thumb()} />
      </SwitchPrimitive.Root>
    </label>
  );
}

export { SwitchField, switchStyles };
export type { SwitchFieldProps };
