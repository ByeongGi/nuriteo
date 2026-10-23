"use client";

import type { ComponentProps } from "react";
import { tv } from "tailwind-variants";
import type { VariantProps } from "tailwind-variants";

const badgeVariants = tv({
  base: "inline-flex items-center justify-center rounded-full border font-semibold whitespace-nowrap",
  variants: {
    variant: {
      count: "border-muted-border bg-raised text-muted-foreground",
      status: "border-transparent bg-subtle text-foreground"
    },
    tone: {
      neutral: "",
      accent: "border-primary/20 bg-selected text-link",
      success: "border-success/20 bg-success-subtle text-success",
      warning: "border-warning/20 bg-warning/10 text-warning",
      danger: "border-danger/20 bg-danger/10 text-danger"
    },
    size: {
      sm: "min-h-6 px-2 text-[var(--n-font-size-2xs)]",
      md: "min-h-8 px-3 text-xs"
    }
  },
  defaultVariants: {
    size: "md",
    tone: "neutral",
    variant: "count"
  }
});

type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

function Badge({ className, size, tone, variant, ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      className={badgeVariants({ className, size, tone, variant })}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
