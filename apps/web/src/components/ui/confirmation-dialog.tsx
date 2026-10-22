"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useRef } from "react";
import { tv } from "tailwind-variants";
import type { VariantProps } from "tailwind-variants";

import { Button } from "#src/components/ui/button.tsx";

const confirmationDialogStyles = tv({
  slots: {
    backdrop:
      "fixed inset-0 z-[100] bg-[color-mix(in_srgb,var(--n-color-bg-canvas)_64%,transparent)] backdrop-blur-sm transition-opacity duration-fast data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none",
    viewport: "fixed inset-0 z-[100] grid place-items-center overflow-y-auto p-5",
    popup:
      "grid w-full max-w-[30rem] grid-cols-[auto_minmax(0,1fr)] gap-4 rounded-xl border border-border bg-raised p-6 text-foreground shadow-overlay outline-none transition-[opacity,transform] duration-fast data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 motion-reduce:transition-none",
    indicator: "grid size-9 shrink-0 place-items-center rounded-full text-sm font-bold",
    copy: "min-w-0",
    title: "m-0 text-lg font-semibold tracking-tight",
    description: "mt-2 text-sm leading-relaxed text-muted-foreground",
    actions: "col-span-full mt-2 flex flex-wrap justify-end gap-2"
  },
  variants: {
    tone: {
      danger: { indicator: "bg-danger-subtle text-danger" },
      primary: { indicator: "bg-info-subtle text-primary" }
    }
  },
  defaultVariants: { tone: "danger" }
});

interface ConfirmationDialogProps extends VariantProps<typeof confirmationDialogStyles> {
  readonly busy?: boolean;
  readonly cancelLabel?: string;
  readonly confirmLabel: string;
  readonly description: string;
  readonly open: boolean;
  readonly title: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

function ConfirmationDialog({
  busy = false,
  cancelLabel = "취소",
  confirmLabel,
  description,
  open,
  title,
  tone = "danger",
  onCancel,
  onConfirm
}: ConfirmationDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const styles = confirmationDialogStyles({ tone });

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onCancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={styles.backdrop()} />
        <AlertDialog.Viewport className={styles.viewport()}>
          <AlertDialog.Popup aria-busy={busy} className={styles.popup()} initialFocus={cancelRef}>
            <div aria-hidden="true" className={styles.indicator()}>!</div>
            <div className={styles.copy()}>
              <AlertDialog.Title className={styles.title()}>{title}</AlertDialog.Title>
              <AlertDialog.Description className={styles.description()}>{description}</AlertDialog.Description>
            </div>
            <div className={styles.actions()}>
              <Button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}>
                {cancelLabel}
              </Button>
              <Button
                type="button"
                variant={tone === "danger" ? "danger" : "primary"}
                disabled={busy}
                onClick={onConfirm}
              >
                {confirmLabel}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export { ConfirmationDialog, confirmationDialogStyles };
export type { ConfirmationDialogProps };
