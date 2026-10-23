"use client";

import type { ComponentProps } from "react";
import { tv } from "tailwind-variants";
import type { VariantProps } from "tailwind-variants";

const textareaVariants = tv({
  base: "min-h-28 w-full min-w-0 resize-y rounded-md border border-strong-border bg-surface px-3 py-2 text-sm leading-relaxed text-foreground shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground hover:border-focus focus:border-focus focus:ring-2 focus:ring-focus/20 disabled:cursor-not-allowed disabled:bg-disabled disabled:text-disabled-foreground motion-reduce:transition-none",
  variants: {
    resize: {
      both: "resize",
      horizontal: "resize-x",
      none: "resize-none",
      vertical: "resize-y"
    }
  },
  defaultVariants: { resize: "vertical" }
});

type TextareaProps = ComponentProps<"textarea"> & VariantProps<typeof textareaVariants>;

function Textarea({ className, resize, ...props }: TextareaProps) {
  return <textarea data-slot="textarea" className={textareaVariants({ className, resize })} {...props} />;
}

export { Textarea, textareaVariants };
export type { TextareaProps };
