"use client";

import { Accordion } from "@base-ui/react/accordion";
import { tv } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const accordionStyles = tv({
  slots: {
    root: "divide-y divide-border rounded-lg border border-border bg-surface",
    item: "min-w-0 first:rounded-t-lg last:rounded-b-lg",
    header: "m-0",
    trigger: "group flex min-h-11 w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold text-foreground outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
    indicator: "text-muted-foreground transition-transform duration-fast group-data-[panel-open]:rotate-180 motion-reduce:transition-none",
    panel: "h-[var(--accordion-panel-height)] overflow-hidden text-sm text-muted-foreground transition-[height] duration-normal data-[ending-style]:h-0 data-[starting-style]:h-0 motion-reduce:transition-none",
    content: "px-4 pb-4 leading-relaxed"
  }
});

function AccordionRoot({ className, ...props }: Accordion.Root.Props) { const s = accordionStyles(); return <Accordion.Root data-slot="accordion" className={resolveComponentClassName(className, (v) => s.root({ className: v }))} {...props} />; }
function AccordionItem({ className, ...props }: Accordion.Item.Props) { const s = accordionStyles(); return <Accordion.Item data-slot="accordion-item" className={resolveComponentClassName(className, (v) => s.item({ className: v }))} {...props} />; }
function AccordionHeader({ className, ...props }: Accordion.Header.Props) { const s = accordionStyles(); return <Accordion.Header data-slot="accordion-header" className={resolveComponentClassName(className, (v) => s.header({ className: v }))} {...props} />; }
function AccordionTrigger({ className, ...props }: Accordion.Trigger.Props) { const s = accordionStyles(); return <Accordion.Trigger data-slot="accordion-trigger" className={resolveComponentClassName(className, (v) => s.trigger({ className: v }))} {...props} />; }
function AccordionPanel({ className, ...props }: Accordion.Panel.Props) { const s = accordionStyles(); return <Accordion.Panel data-slot="accordion-panel" className={resolveComponentClassName(className, (v) => s.panel({ className: v }))} {...props} />; }
function AccordionIndicator({ className, ...props }: React.ComponentProps<"span">) { const s = accordionStyles(); return <span aria-hidden="true" data-slot="accordion-indicator" className={s.indicator({ className })} {...props} />; }
function AccordionContent({ className, ...props }: React.ComponentProps<"div">) { const s = accordionStyles(); return <div data-slot="accordion-content" className={s.content({ className })} {...props} />; }

export { AccordionContent, AccordionHeader, AccordionIndicator, AccordionItem, AccordionPanel, AccordionRoot, AccordionTrigger, accordionStyles };
