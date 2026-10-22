"use client";

import { PreviewCard } from "@base-ui/react/preview-card";
import { tv } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const previewCardStyles = tv({
  slots: {
    positioner: "z-[110] outline-none",
    popup: "w-80 max-w-[calc(100vw-2rem)] origin-[var(--transform-origin)] rounded-lg border border-border bg-raised p-4 text-sm text-foreground shadow-overlay outline-none transition-[opacity,transform] duration-fast data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 motion-reduce:transition-none",
    arrow: "text-raised"
  }
});

const PreviewCardRoot = PreviewCard.Root;
const PreviewCardTrigger = PreviewCard.Trigger;
const PreviewCardPortal = PreviewCard.Portal;

function PreviewCardPositioner({ className, sideOffset = 8, ...props }: PreviewCard.Positioner.Props) {
  const styles = previewCardStyles();
  return <PreviewCard.Positioner data-slot="preview-card-positioner" sideOffset={sideOffset} className={resolveComponentClassName(className, (override) => styles.positioner({ className: override }))} {...props} />;
}

function PreviewCardPopup({ className, ...props }: PreviewCard.Popup.Props) {
  const styles = previewCardStyles();
  return <PreviewCard.Popup data-slot="preview-card-popup" className={resolveComponentClassName(className, (override) => styles.popup({ className: override }))} {...props} />;
}

function PreviewCardArrow({ className, ...props }: PreviewCard.Arrow.Props) {
  const styles = previewCardStyles();
  return <PreviewCard.Arrow data-slot="preview-card-arrow" className={resolveComponentClassName(className, (override) => styles.arrow({ className: override }))} {...props} />;
}

export { PreviewCardArrow, PreviewCardPopup, PreviewCardPortal, PreviewCardPositioner, PreviewCardRoot, PreviewCardTrigger, previewCardStyles };
