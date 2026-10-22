"use client";

import { OTPField } from "@base-ui/react/otp-field";
import { tv } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const otpFieldStyles = tv({
  slots: {
    root: "flex items-center gap-2",
    input: "size-11 rounded-md border border-strong-border bg-surface text-center text-lg font-semibold tabular-nums text-foreground shadow-xs outline-none transition-[border-color,box-shadow] focus:border-focus focus:ring-2 focus:ring-focus/20 data-[filled]:border-primary disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
    separator: "px-1 text-muted-foreground"
  }
});

function OTPFieldRoot({ className, ...props }: OTPField.Root.Props) {
  const styles = otpFieldStyles();
  return <OTPField.Root data-slot="otp-field" className={resolveComponentClassName(className, (override) => styles.root({ className: override }))} {...props} />;
}

function OTPFieldInput({ className, ...props }: OTPField.Input.Props) {
  const styles = otpFieldStyles();
  return <OTPField.Input data-slot="otp-field-input" className={resolveComponentClassName(className, (override) => styles.input({ className: override }))} {...props} />;
}

function OTPFieldSeparator({ className, ...props }: React.ComponentProps<"span">) {
  const styles = otpFieldStyles();
  return <span aria-hidden="true" data-slot="otp-field-separator" className={styles.separator({ className })} {...props} />;
}

export { OTPFieldInput, OTPFieldRoot, OTPFieldSeparator, otpFieldStyles };
