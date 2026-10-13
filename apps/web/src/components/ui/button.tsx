"use client";

import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";

import { cn } from "../../lib/cn.ts";

const buttonVariants = cva(
  "inline-flex min-h-10 items-center justify-center rounded-md border px-4 text-sm font-medium transition-colors duration-fast outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
  {
    variants: {
      variant: {
        primary:
          "border-primary bg-primary text-on-primary hover:bg-primary-strong active:bg-primary-strong",
        secondary:
          "border-border bg-surface text-foreground hover:bg-hover active:bg-active",
        ghost: "border-transparent bg-transparent text-foreground hover:bg-hover active:bg-active",
        danger: "border-danger bg-danger text-on-danger hover:brightness-110"
      },
      size: {
        sm: "min-h-9 px-3 text-xs",
        md: "min-h-10 px-4 text-sm",
        lg: "min-h-11 px-5 text-base",
        icon: "size-10 p-0"
      }
    },
    defaultVariants: {
      size: "md",
      variant: "secondary"
    }
  }
);

type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants>;

function Button({ className, size, variant, ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ size, variant }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
