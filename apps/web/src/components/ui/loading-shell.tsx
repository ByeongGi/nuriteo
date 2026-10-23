"use client";

import { tv } from "tailwind-variants";

const loadingShellStyles = tv({
  slots: {
    root: "grid w-full max-w-[50rem] gap-4",
    line: "h-4 w-full animate-pulse rounded-md bg-subtle motion-reduce:animate-none",
    shortLine: "w-28",
    titleLine: "h-16 w-[min(100%,34rem)]",
    grid: "mt-8 grid grid-cols-1 gap-3 min-[48rem]:grid-cols-3",
    card: "min-h-40 animate-pulse rounded-md bg-subtle motion-reduce:animate-none"
  }
});

interface LoadingShellProps {
  readonly cardCount?: number | undefined;
  readonly label: string;
  readonly showBodyLine?: boolean | undefined;
}

function LoadingShell({
  cardCount = 3,
  label,
  showBodyLine = false
}: LoadingShellProps) {
  const styles = loadingShellStyles();

  return (
    <>
      <span className="sr-only" aria-live="polite">{label}</span>
      <div className={styles.root()} aria-hidden="true">
        <span className={styles.line({ className: styles.shortLine() })} />
        <span className={styles.line({ className: styles.titleLine() })} />
        {showBodyLine ? <span className={styles.line()} /> : null}
        <div className={styles.grid()}>
          {Array.from({ length: cardCount }, (_, index) => <div className={styles.card()} key={index} />)}
        </div>
      </div>
    </>
  );
}

export { LoadingShell, loadingShellStyles };
export type { LoadingShellProps };
