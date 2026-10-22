"use client";

import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";
import { tv } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const separatorStyles = tv({
  base: "shrink-0 bg-border",
  variants: {
    orientation: {
      horizontal: "h-px w-full",
      vertical: "h-full min-h-4 w-px"
    }
  },
  defaultVariants: { orientation: "horizontal" }
});

function Separator({ className, orientation = "horizontal", ...props }: SeparatorPrimitive.Props) {
  return <SeparatorPrimitive data-slot="separator" orientation={orientation} className={resolveComponentClassName(className, (override) => separatorStyles({ className: override, orientation }))} {...props} />;
}

export { Separator, separatorStyles };
