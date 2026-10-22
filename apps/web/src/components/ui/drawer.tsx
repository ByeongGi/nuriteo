"use client";

import { Drawer } from "@base-ui/react/drawer";
import { tv } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const drawerStyles = tv({
  slots: {
    backdrop: "fixed inset-0 z-[100] bg-[color-mix(in_srgb,var(--n-color-bg-canvas)_64%,transparent)] backdrop-blur-sm transition-opacity duration-fast data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none",
    viewport: "fixed inset-0 z-[100] flex items-end justify-center",
    popup: "max-h-[90dvh] w-full max-w-2xl rounded-t-2xl border border-b-0 border-border bg-raised text-foreground shadow-overlay outline-none transition-transform duration-normal data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full motion-reduce:transition-none",
    handle: "mx-auto mt-3 h-1 w-10 rounded-full bg-strong-border",
    content: "overflow-y-auto px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4",
    title: "text-lg font-semibold tracking-tight",
    description: "mt-2 text-sm leading-relaxed text-muted-foreground"
  }
});

const DrawerRoot = Drawer.Root;
const DrawerTrigger = Drawer.Trigger;
const DrawerPortal = Drawer.Portal;
const DrawerClose = Drawer.Close;

function DrawerBackdrop({ className, ...props }: Drawer.Backdrop.Props) { const s = drawerStyles(); return <Drawer.Backdrop data-slot="drawer-backdrop" className={resolveComponentClassName(className, (v) => s.backdrop({ className: v }))} {...props} />; }
function DrawerViewport({ className, ...props }: Drawer.Viewport.Props) { const s = drawerStyles(); return <Drawer.Viewport data-slot="drawer-viewport" className={resolveComponentClassName(className, (v) => s.viewport({ className: v }))} {...props} />; }
function DrawerPopup({ className, ...props }: Drawer.Popup.Props) { const s = drawerStyles(); return <Drawer.Popup data-slot="drawer-popup" className={resolveComponentClassName(className, (v) => s.popup({ className: v }))} {...props} />; }
function DrawerContent({ className, ...props }: Drawer.Content.Props) { const s = drawerStyles(); return <Drawer.Content data-slot="drawer-content" className={resolveComponentClassName(className, (v) => s.content({ className: v }))} {...props} />; }
function DrawerTitle({ className, ...props }: Drawer.Title.Props) { const s = drawerStyles(); return <Drawer.Title data-slot="drawer-title" className={resolveComponentClassName(className, (v) => s.title({ className: v }))} {...props} />; }
function DrawerDescription({ className, ...props }: Drawer.Description.Props) { const s = drawerStyles(); return <Drawer.Description data-slot="drawer-description" className={resolveComponentClassName(className, (v) => s.description({ className: v }))} {...props} />; }
function DrawerHandle({ className, ...props }: React.ComponentProps<"div">) { const s = drawerStyles(); return <div aria-hidden="true" data-slot="drawer-handle" className={s.handle({ className })} {...props} />; }

export { DrawerBackdrop, DrawerClose, DrawerContent, DrawerDescription, DrawerHandle, DrawerPopup, DrawerPortal, DrawerRoot, DrawerTitle, DrawerTrigger, DrawerViewport, drawerStyles };
