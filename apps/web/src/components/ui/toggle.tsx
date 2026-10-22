"use client";

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { tv } from "tailwind-variants";
import type { VariantProps } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const toggleVariants = tv({
  base: "inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-transparent px-3 text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[pressed]:border-strong-border data-[pressed]:bg-surface data-[pressed]:text-foreground data-[pressed]:shadow-xs disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
  variants: {
    size: { sm: "min-h-8 px-2 text-xs", md: "min-h-9 px-3 text-sm", icon: "size-9 p-0" }
  },
  defaultVariants: { size: "md" }
});

type ToggleProps = TogglePrimitive.Props & VariantProps<typeof toggleVariants>;

function Toggle({ className, size, ...props }: ToggleProps) {
  return <TogglePrimitive data-slot="toggle" className={resolveComponentClassName(className, (override) => toggleVariants({ className: override, size }))} {...props} />;
}

export { Toggle, toggleVariants };
export type { ToggleProps };
