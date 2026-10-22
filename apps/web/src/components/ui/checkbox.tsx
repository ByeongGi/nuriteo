"use client";

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import type { ReactNode } from "react";
import { tv } from "tailwind-variants";
import type { VariantProps } from "tailwind-variants";

const checkboxStyles = tv({
  slots: {
    root: "flex min-w-0 cursor-pointer items-start gap-3 text-sm text-foreground has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:opacity-50",
    control:
      "mt-0.5 grid size-4 shrink-0 place-items-center rounded-[0.3rem] border border-strong-border bg-surface text-on-primary outline-none transition-colors data-[checked]:border-primary data-[checked]:bg-primary focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    indicator: "grid place-items-center",
    copy: "grid min-w-0 gap-1",
    label: "font-medium leading-5",
    description: "text-xs font-normal leading-relaxed text-subtle-foreground"
  },
  variants: {
    appearance: {
      card: {
        root: "w-full items-center justify-between rounded-md border border-muted-border bg-surface px-3 py-2.5",
        control: "order-2 mt-0",
        copy: "order-1"
      },
      plain: {}
    }
  },
  defaultVariants: { appearance: "plain" }
});

type CheckboxFieldProps = Pick<CheckboxPrimitive.Root.Props, "checked" | "defaultChecked" | "disabled" | "name" | "onCheckedChange" | "readOnly" | "required" | "value"> &
  VariantProps<typeof checkboxStyles> & {
    readonly description?: ReactNode;
    readonly label: ReactNode;
  };

function CheckboxField({ appearance, description, label, ...props }: CheckboxFieldProps) {
  const styles = checkboxStyles({ appearance });
  return (
    <label className={styles.root()}>
      <CheckboxPrimitive.Root className={styles.control()} {...props}>
        <CheckboxPrimitive.Indicator className={styles.indicator()}>
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="m2.5 6 2.1 2.1 4.9-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <span className={styles.copy()}>
        <span className={styles.label()}>{label}</span>
        {description ? <span className={styles.description()}>{description}</span> : null}
      </span>
    </label>
  );
}

export { CheckboxField, checkboxStyles };
export type { CheckboxFieldProps };
