"use client";

import { Dialog } from "@base-ui/react/dialog";
import { tv } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const dialogStyles = tv({
  slots: {
    backdrop: "fixed inset-0 z-[100] bg-[color-mix(in_srgb,var(--n-color-bg-canvas)_64%,transparent)] backdrop-blur-sm transition-opacity duration-fast data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none",
    viewport: "fixed inset-0 z-[100] grid place-items-center overflow-y-auto p-5",
    popup: "w-full max-w-lg rounded-xl border border-border bg-raised p-6 text-foreground shadow-overlay outline-none transition-[opacity,transform] duration-fast data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 motion-reduce:transition-none",
    title: "text-lg font-semibold tracking-tight text-foreground",
    description: "mt-2 text-sm leading-relaxed text-muted-foreground",
    actions: "mt-6 flex flex-wrap justify-end gap-2"
  }
});

const DialogRoot = Dialog.Root;
const DialogTrigger = Dialog.Trigger;
const DialogPortal = Dialog.Portal;
const DialogClose = Dialog.Close;

function DialogBackdrop({ className, ...props }: Dialog.Backdrop.Props) {
  const styles = dialogStyles();
  return <Dialog.Backdrop data-slot="dialog-backdrop" className={resolveComponentClassName(className, (override) => styles.backdrop({ className: override }))} {...props} />;
}

function DialogViewport({ className, ...props }: Dialog.Viewport.Props) {
  const styles = dialogStyles();
  return <Dialog.Viewport data-slot="dialog-viewport" className={resolveComponentClassName(className, (override) => styles.viewport({ className: override }))} {...props} />;
}

function DialogPopup({ className, ...props }: Dialog.Popup.Props) {
  const styles = dialogStyles();
  return <Dialog.Popup data-slot="dialog-popup" className={resolveComponentClassName(className, (override) => styles.popup({ className: override }))} {...props} />;
}

function DialogTitle({ className, ...props }: Dialog.Title.Props) {
  const styles = dialogStyles();
  return <Dialog.Title data-slot="dialog-title" className={resolveComponentClassName(className, (override) => styles.title({ className: override }))} {...props} />;
}

function DialogDescription({ className, ...props }: Dialog.Description.Props) {
  const styles = dialogStyles();
  return <Dialog.Description data-slot="dialog-description" className={resolveComponentClassName(className, (override) => styles.description({ className: override }))} {...props} />;
}

function DialogActions({ className, ...props }: React.ComponentProps<"div">) {
  const styles = dialogStyles();
  return <div data-slot="dialog-actions" className={styles.actions({ className })} {...props} />;
}

export { DialogActions, DialogBackdrop, DialogClose, DialogDescription, DialogPopup, DialogPortal, DialogRoot, DialogTitle, DialogTrigger, DialogViewport, dialogStyles };
