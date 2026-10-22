"use client";

import { Toast } from "@base-ui/react/toast";
import { tv } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const toastStyles = tv({
  slots: {
    viewport: "fixed bottom-0 right-0 z-[130] flex w-[min(26rem,100vw)] flex-col gap-2 p-4 sm:bottom-2 sm:right-2",
    root: "grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 rounded-lg border border-border bg-raised p-4 text-foreground shadow-overlay outline-none transition-[opacity,transform] duration-normal data-[ending-style]:translate-x-4 data-[ending-style]:opacity-0 data-[starting-style]:translate-y-4 data-[starting-style]:opacity-0 data-[swiping]:translate-x-[var(--toast-swipe-movement-x)] data-[limited]:hidden motion-reduce:transition-none",
    content: "min-w-0",
    title: "text-sm font-semibold",
    description: "mt-1 text-sm leading-relaxed text-muted-foreground",
    close: "col-start-2 row-start-1 grid size-8 place-items-center rounded-md text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus",
    action: "mt-3 inline-flex min-h-8 items-center justify-center rounded-md border border-strong-border bg-surface px-3 text-xs font-semibold outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
  }
});

const ToastProvider = Toast.Provider;
const ToastPortal = Toast.Portal;
const useToastManager = Toast.useToastManager;

function ToastViewport({ className, ...props }: Toast.Viewport.Props) { const s = toastStyles(); return <Toast.Viewport data-slot="toast-viewport" className={resolveComponentClassName(className, (v) => s.viewport({ className: v }))} {...props} />; }
function ToastRoot({ className, ...props }: Toast.Root.Props) { const s = toastStyles(); return <Toast.Root data-slot="toast" className={resolveComponentClassName(className, (v) => s.root({ className: v }))} {...props} />; }
function ToastContent({ className, ...props }: Toast.Content.Props) { const s = toastStyles(); return <Toast.Content data-slot="toast-content" className={resolveComponentClassName(className, (v) => s.content({ className: v }))} {...props} />; }
function ToastTitle({ className, ...props }: Toast.Title.Props) { const s = toastStyles(); return <Toast.Title data-slot="toast-title" className={resolveComponentClassName(className, (v) => s.title({ className: v }))} {...props} />; }
function ToastDescription({ className, ...props }: Toast.Description.Props) { const s = toastStyles(); return <Toast.Description data-slot="toast-description" className={resolveComponentClassName(className, (v) => s.description({ className: v }))} {...props} />; }
function ToastClose({ className, ...props }: Toast.Close.Props) { const s = toastStyles(); return <Toast.Close data-slot="toast-close" className={resolveComponentClassName(className, (v) => s.close({ className: v }))} {...props} />; }
function ToastAction({ className, ...props }: Toast.Action.Props) { const s = toastStyles(); return <Toast.Action data-slot="toast-action" className={resolveComponentClassName(className, (v) => s.action({ className: v }))} {...props} />; }

export { ToastAction, ToastClose, ToastContent, ToastDescription, ToastPortal, ToastProvider, ToastRoot, ToastTitle, ToastViewport, toastStyles, useToastManager };
