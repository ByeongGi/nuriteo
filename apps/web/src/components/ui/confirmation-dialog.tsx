"use client";

import { useEffect, useId, useRef } from "react";

import { Button } from "./button.tsx";

interface ConfirmationDialogProps {
  readonly busy?: boolean;
  readonly cancelLabel?: string;
  readonly confirmLabel: string;
  readonly description: string;
  readonly open: boolean;
  readonly title: string;
  readonly tone?: "danger" | "primary";
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

const FOCUSABLE_ELEMENTS =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ConfirmationDialog({
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
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    confirmRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_ELEMENTS)
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [busy, onCancel, open]);

  if (!open) return null;

  return (
    <div
      className="confirmation-dialog__backdrop"
      onMouseDown={(event) => {
        if (!busy && event.currentTarget === event.target) onCancel();
      }}
    >
      <section
        ref={dialogRef}
        className="confirmation-dialog"
        role={tone === "danger" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
      >
        <div className={`confirmation-dialog__indicator confirmation-dialog__indicator--${tone}`} aria-hidden="true">!</div>
        <div>
          <h2 id={titleId}>{title}</h2>
          <p id={descriptionId}>{description}</p>
        </div>
        <div className="confirmation-dialog__actions">
          <Button type="button" disabled={busy} onClick={onCancel}>{cancelLabel}</Button>
          <Button
            ref={confirmRef}
            type="button"
            variant={tone === "danger" ? "danger" : "primary"}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </section>
    </div>
  );
}
