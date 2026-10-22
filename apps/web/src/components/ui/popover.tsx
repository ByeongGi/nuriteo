"use client";

import { Popover } from "@base-ui/react/popover";
import { tv } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const popoverStyles = tv({
  slots: {
    positioner: "z-[110] outline-none",
    popup: "w-72 max-w-[calc(100vw-2rem)] origin-[var(--transform-origin)] rounded-lg border border-border bg-raised p-4 text-foreground shadow-overlay outline-none transition-[opacity,transform] duration-fast data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 motion-reduce:transition-none",
    title: "text-sm font-semibold text-foreground",
    description: "mt-1 text-sm leading-relaxed text-muted-foreground",
    arrow: "text-raised"
  }
});

const PopoverRoot = Popover.Root;
const PopoverTrigger = Popover.Trigger;
const PopoverPortal = Popover.Portal;
const PopoverClose = Popover.Close;

function PopoverPositioner({ className, sideOffset = 8, ...props }: Popover.Positioner.Props) {
  const styles = popoverStyles();
  return <Popover.Positioner data-slot="popover-positioner" sideOffset={sideOffset} className={resolveComponentClassName(className, (override) => styles.positioner({ className: override }))} {...props} />;
}

function PopoverPopup({ className, ...props }: Popover.Popup.Props) {
  const styles = popoverStyles();
  return <Popover.Popup data-slot="popover-popup" className={resolveComponentClassName(className, (override) => styles.popup({ className: override }))} {...props} />;
}

function PopoverTitle({ className, ...props }: Popover.Title.Props) {
  const styles = popoverStyles();
  return <Popover.Title data-slot="popover-title" className={resolveComponentClassName(className, (override) => styles.title({ className: override }))} {...props} />;
}

function PopoverDescription({ className, ...props }: Popover.Description.Props) {
  const styles = popoverStyles();
  return <Popover.Description data-slot="popover-description" className={resolveComponentClassName(className, (override) => styles.description({ className: override }))} {...props} />;
}

function PopoverArrow({ className, ...props }: Popover.Arrow.Props) {
  const styles = popoverStyles();
  return <Popover.Arrow data-slot="popover-arrow" className={resolveComponentClassName(className, (override) => styles.arrow({ className: override }))} {...props} />;
}

export { PopoverArrow, PopoverClose, PopoverDescription, PopoverPopup, PopoverPortal, PopoverPositioner, PopoverRoot, PopoverTitle, PopoverTrigger, popoverStyles };
