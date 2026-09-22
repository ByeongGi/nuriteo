import { useEffect, useRef } from "react";

export interface ContextMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
}

export function ContextMenu({
  open,
  x,
  y,
  items,
  onClose,
  onSelect
}: {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, open]);

  if (!open) return null;

  const maxX = typeof window !== "undefined" ? window.innerWidth - 180 : x;
  const maxY = typeof window !== "undefined" ? window.innerHeight - 8 : y;
  const left = Math.max(8, Math.min(x, maxX));
  const top = Math.max(8, Math.min(y, maxY));

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Context menu"
      className="fixed z-[80] min-w-[160px] overflow-hidden rounded-lg border border-cargo-line bg-cargo-panel py-1 shadow-[var(--shadow)]"
      style={{ left, top }}
    >
      {items.map((item) => {
        if (item.separator) {
          return <div key={item.id} className="my-1 border-t border-cargo-line" role="separator" />;
        }
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={`flex w-full px-3 py-1.5 text-left text-xs ${
              item.danger ? "text-cargo-bad hover:bg-cargo-bad/10" : "text-cargo-ink hover:bg-cargo-panel-2"
            } disabled:opacity-40`}
            onClick={() => {
              if (item.disabled) return;
              onSelect(item.id);
              onClose();
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
