"use client";

import { CheckboxGroup as CheckboxGroupPrimitive } from "@base-ui/react/checkbox-group";
import { tv } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const checkboxGroupStyles = tv({ base: "grid min-w-0 gap-3" });

function CheckboxGroup({ className, ...props }: CheckboxGroupPrimitive.Props) {
  return <CheckboxGroupPrimitive data-slot="checkbox-group" className={resolveComponentClassName(className, (v) => checkboxGroupStyles({ className: v }))} {...props} />;
}

export { CheckboxGroup, checkboxGroupStyles };
