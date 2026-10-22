"use client";

import { Toolbar } from "@base-ui/react/toolbar";
import { tv } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const toolbarStyles = tv({
  slots: {
    root: "flex min-w-0 items-center gap-1 rounded-lg border border-border bg-surface p-1 shadow-xs data-[orientation=vertical]:w-fit data-[orientation=vertical]:flex-col",
    group: "flex min-w-0 items-center gap-1 data-[orientation=vertical]:flex-col",
    button: "inline-flex size-9 shrink-0 items-center justify-center rounded-md text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus data-[pressed]:bg-active data-[pressed]:text-foreground disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
    link: "inline-flex min-h-9 items-center justify-center rounded-md px-3 text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus motion-reduce:transition-none",
    input: "min-h-9 min-w-0 rounded-md border border-strong-border bg-background px-3 text-sm text-foreground outline-none focus:border-focus focus:ring-2 focus:ring-focus/20",
    separator: "mx-1 h-5 w-px shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full"
  }
});

function ToolbarRoot({ className, ...props }: Toolbar.Root.Props) { const s = toolbarStyles(); return <Toolbar.Root data-slot="toolbar" className={resolveComponentClassName(className, (v) => s.root({ className: v }))} {...props} />; }
function ToolbarGroup({ className, ...props }: Toolbar.Group.Props) { const s = toolbarStyles(); return <Toolbar.Group data-slot="toolbar-group" className={resolveComponentClassName(className, (v) => s.group({ className: v }))} {...props} />; }
function ToolbarButton({ className, ...props }: Toolbar.Button.Props) { const s = toolbarStyles(); return <Toolbar.Button data-slot="toolbar-button" className={resolveComponentClassName(className, (v) => s.button({ className: v }))} {...props} />; }
function ToolbarLink({ className, ...props }: Toolbar.Link.Props) { const s = toolbarStyles(); return <Toolbar.Link data-slot="toolbar-link" className={resolveComponentClassName(className, (v) => s.link({ className: v }))} {...props} />; }
function ToolbarInput({ className, ...props }: Toolbar.Input.Props) { const s = toolbarStyles(); return <Toolbar.Input data-slot="toolbar-input" className={resolveComponentClassName(className, (v) => s.input({ className: v }))} {...props} />; }
function ToolbarSeparator({ className, ...props }: Toolbar.Separator.Props) { const s = toolbarStyles(); return <Toolbar.Separator data-slot="toolbar-separator" className={resolveComponentClassName(className, (v) => s.separator({ className: v }))} {...props} />; }

export { ToolbarButton, ToolbarGroup, ToolbarInput, ToolbarLink, ToolbarRoot, ToolbarSeparator, toolbarStyles };
