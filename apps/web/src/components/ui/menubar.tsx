"use client";

import { Menubar as MenubarPrimitive } from "@base-ui/react/menubar";
import { tv } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const menubarStyles = tv({ base: "flex min-w-0 items-center gap-1 rounded-lg border border-border bg-surface p-1 shadow-xs data-[orientation=vertical]:w-fit data-[orientation=vertical]:flex-col" });

function Menubar({ className, ...props }: MenubarPrimitive.Props) {
  return <MenubarPrimitive data-slot="menubar" className={resolveComponentClassName(className, (v) => menubarStyles({ className: v }))} {...props} />;
}

export { Menubar, menubarStyles };
