"use client";

import { ScrollArea } from "@base-ui/react/scroll-area";
import { tv } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const scrollAreaStyles = tv({
  slots: {
    root: "relative min-h-0 min-w-0 overflow-hidden",
    viewport: "size-full overscroll-contain focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[-2px]",
    content: "min-w-full",
    scrollbar: "m-1 flex w-2.5 touch-none select-none justify-center rounded-full opacity-0 transition-opacity data-[hovering]:opacity-100 data-[scrolling]:opacity-100 data-[orientation=horizontal]:h-2.5 data-[orientation=horizontal]:w-auto data-[orientation=horizontal]:items-center motion-reduce:transition-none",
    thumb: "w-full rounded-full bg-strong-border hover:bg-muted-foreground data-[orientation=horizontal]:h-full",
    corner: "bg-transparent"
  }
});

function ScrollAreaRoot({ className, ...props }: ScrollArea.Root.Props) { const s = scrollAreaStyles(); return <ScrollArea.Root data-slot="scroll-area" className={resolveComponentClassName(className, (v) => s.root({ className: v }))} {...props} />; }
function ScrollAreaViewport({ className, ...props }: ScrollArea.Viewport.Props) { const s = scrollAreaStyles(); return <ScrollArea.Viewport data-slot="scroll-area-viewport" className={resolveComponentClassName(className, (v) => s.viewport({ className: v }))} {...props} />; }
function ScrollAreaContent({ className, ...props }: ScrollArea.Content.Props) { const s = scrollAreaStyles(); return <ScrollArea.Content data-slot="scroll-area-content" className={resolveComponentClassName(className, (v) => s.content({ className: v }))} {...props} />; }
function ScrollAreaScrollbar({ className, ...props }: ScrollArea.Scrollbar.Props) { const s = scrollAreaStyles(); return <ScrollArea.Scrollbar data-slot="scroll-area-scrollbar" className={resolveComponentClassName(className, (v) => s.scrollbar({ className: v }))} {...props} />; }
function ScrollAreaThumb({ className, ...props }: ScrollArea.Thumb.Props) { const s = scrollAreaStyles(); return <ScrollArea.Thumb data-slot="scroll-area-thumb" className={resolveComponentClassName(className, (v) => s.thumb({ className: v }))} {...props} />; }
function ScrollAreaCorner({ className, ...props }: ScrollArea.Corner.Props) { const s = scrollAreaStyles(); return <ScrollArea.Corner data-slot="scroll-area-corner" className={resolveComponentClassName(className, (v) => s.corner({ className: v }))} {...props} />; }

export { ScrollAreaContent, ScrollAreaCorner, ScrollAreaRoot, ScrollAreaScrollbar, ScrollAreaThumb, ScrollAreaViewport, scrollAreaStyles };
