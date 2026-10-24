import type { ReactNode } from "react";
import { tv } from "tailwind-variants";

const settingsGroupStyles = tv({
  slots: {
    root: "overflow-hidden rounded-lg border border-muted-border bg-surface",
    header: "grid gap-0.5 border-b border-muted-border px-4 py-3",
    title: "m-0 text-sm font-semibold text-foreground",
    description: "m-0 text-xs leading-relaxed text-muted-foreground",
    row: "grid min-h-16 grid-cols-[minmax(0,1fr)_minmax(12rem,0.72fr)] items-center gap-6 px-4 py-3 [&+&]:border-t [&+&]:border-muted-border max-[42rem]:grid-cols-1 max-[42rem]:items-stretch max-[42rem]:gap-3",
    copy: "grid min-w-0 gap-0.5",
    rowTitle: "text-sm font-medium text-foreground",
    rowDescription: "text-xs leading-relaxed text-muted-foreground",
    control: "flex min-w-0 items-center justify-end gap-2 text-sm text-foreground max-[42rem]:justify-start",
    value: "min-w-0 break-words text-right text-sm font-medium text-foreground max-[42rem]:text-left"
  },
  variants: {
    density: {
      comfortable: {},
      compact: {
        header: "py-2.5",
        row: "min-h-14 py-2.5"
      }
    },
    layout: {
      default: {},
      stacked: {
        row: "grid-cols-1 items-stretch gap-3",
        control: "justify-start"
      }
    },
    tone: {
      default: {},
      danger: {
        root: "border-danger/35",
        title: "text-danger"
      }
    }
  },
  defaultVariants: { density: "comfortable", layout: "default", tone: "default" }
});

export function SettingsGroup({ children, density = "comfortable", description, title, tone = "default" }: Readonly<{
  children: ReactNode;
  density?: "comfortable" | "compact";
  description?: string;
  title: string;
  tone?: "danger" | "default";
}>) {
  const styles = settingsGroupStyles({ density, tone });
  return (
    <section className={styles.root()}>
      <header className={styles.header()}>
        <h2 className={styles.title()}>{title}</h2>
        {description ? <p className={styles.description()}>{description}</p> : null}
      </header>
      {children}
    </section>
  );
}

export function SettingsRow({ children, density = "comfortable", description, layout = "default", title }: Readonly<{
  children: ReactNode;
  density?: "comfortable" | "compact";
  description?: string;
  layout?: "default" | "stacked";
  title: string;
}>) {
  const styles = settingsGroupStyles({ density, layout });
  return (
    <div className={styles.row()}>
      <div className={styles.copy()}>
        <strong className={styles.rowTitle()}>{title}</strong>
        {description ? <span className={styles.rowDescription()}>{description}</span> : null}
      </div>
      <div className={styles.control()}>{children}</div>
    </div>
  );
}

export function SettingsValue({ children }: Readonly<{ children: ReactNode }>) {
  return <span className={settingsGroupStyles().value()}>{children}</span>;
}

