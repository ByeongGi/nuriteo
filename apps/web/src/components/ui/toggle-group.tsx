"use client";

import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { tv } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const toggleGroupStyles = tv({ base: "inline-flex min-w-0 items-center gap-1 rounded-lg bg-subtle p-1" });

function ToggleGroup({ className, ...props }: ToggleGroupPrimitive.Props) {
  return <ToggleGroupPrimitive data-slot="toggle-group" className={resolveComponentClassName(className, (override) => toggleGroupStyles({ className: override }))} {...props} />;
}

export { ToggleGroup, toggleGroupStyles };
