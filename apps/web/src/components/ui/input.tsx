"use client";

import { Input as InputPrimitive } from "@base-ui/react/input";
import { tv } from "tailwind-variants";
import type { VariantProps } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const inputVariants = tv({
  base: "min-h-10 w-full min-w-0 rounded-md border border-strong-border bg-surface px-3 text-sm text-foreground shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground hover:border-stronger-border focus:border-focus focus:ring-2 focus:ring-focus/20 disabled:cursor-not-allowed disabled:bg-disabled disabled:text-disabled-foreground motion-reduce:transition-none",
  variants: {
    size: {
      sm: "min-h-9 px-2.5 text-xs",
      md: "min-h-10 px-3 text-sm",
      lg: "min-h-11 px-3.5 text-base"
    }
  },
  defaultVariants: { size: "md" }
});

type InputProps = Omit<InputPrimitive.Props, "size"> & VariantProps<typeof inputVariants>;

function Input({ className, size, ...props }: InputProps) {
  return <InputPrimitive data-slot="input" className={resolveComponentClassName(className, (override) => inputVariants({ className: override, size }))} {...props} />;
}

export { Input, inputVariants };
export type { InputProps };
