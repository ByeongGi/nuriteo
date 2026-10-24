"use client";

import { Button as ButtonPrimitive } from "@base-ui/react/button";
import type { VariantProps } from "tailwind-variants";

import { buttonVariants } from "#src/components/ui/button.styles.ts";

type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants>;

function Button({ className, nativeButton, render, size, variant, ...props }: ButtonProps) {
  const resolveClassName = (override?: string) =>
    buttonVariants({ className: override, size, variant });

  return (
    <ButtonPrimitive
      data-slot="button"
      nativeButton={nativeButton ?? render === undefined}
      render={render}
      className={
        typeof className === "function"
          ? (state) => resolveClassName(className(state))
          : resolveClassName(className)
      }
      {...props}
    />
  );
}

export { Button };
