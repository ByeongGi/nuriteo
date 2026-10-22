"use client";

import { Form as FormPrimitive } from "@base-ui/react/form";
import { tv } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const formStyles = tv({ base: "grid min-w-0 gap-5" });

function Form<FormValues extends Record<string, unknown> = Record<string, unknown>>({
  className,
  ...props
}: FormPrimitive.Props<FormValues>) {
  return <FormPrimitive<FormValues> data-slot="form" className={resolveComponentClassName(className, (override) => formStyles({ className: override }))} {...props} />;
}

export { Form, formStyles };
