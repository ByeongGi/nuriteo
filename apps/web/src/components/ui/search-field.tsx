"use client";

import { tv } from "tailwind-variants";

import { Input } from "#src/components/ui/input.tsx";
import type { InputProps } from "#src/components/ui/input.tsx";

const searchFieldStyles = tv({
  slots: {
    root: "flex min-h-10 min-w-0 items-center gap-2 rounded-md border border-strong-border bg-surface px-3 shadow-xs transition-[border-color,box-shadow] focus-within:border-focus focus-within:ring-2 focus-within:ring-focus/20",
    icon: "shrink-0 text-muted-foreground",
    input: "min-h-0 border-0 bg-transparent p-0 shadow-none hover:border-0 focus:border-0 focus:ring-0"
  }
});

type SearchFieldProps = Omit<InputProps, "aria-label" | "className" | "size" | "type"> & {
  readonly className?: string;
  readonly inputClassName?: string;
  readonly label: string;
};

function SearchField({ className, inputClassName, label, ...props }: SearchFieldProps) {
  const styles = searchFieldStyles();
  return (
    <label className={styles.root({ className })} data-slot="search-field">
      <span className={styles.icon()} aria-hidden="true">⌕</span>
      <span className="sr-only">{label}</span>
      <Input
        aria-label={label}
        className={styles.input({ className: inputClassName })}
        type="search"
        {...props}
      />
    </label>
  );
}

export { SearchField, searchFieldStyles };
export type { SearchFieldProps };
