"use client";

import { Tabs } from "@base-ui/react/tabs";
import { tv } from "tailwind-variants";

const tabsStyles = tv({
  slots: {
    root: "min-w-0",
    list: "relative inline-flex min-w-0 gap-1 rounded-lg bg-subtle p-1",
    tab: "relative z-[1] inline-flex min-h-9 min-w-0 items-center justify-center rounded-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 focus-visible:ring-offset-subtle data-[active]:text-foreground disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
    indicator: "absolute inset-y-1 left-0 w-[var(--active-tab-width)] translate-x-[var(--active-tab-left)] rounded-md bg-surface shadow-xs transition-[width,transform] duration-fast motion-reduce:transition-none",
    panel: "min-w-0 pt-4 outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background"
  }
});

function TabsRoot({ className, ...props }: Tabs.Root.Props) {
  const styles = tabsStyles();
  return (
    <Tabs.Root
      data-slot="tabs"
      className={typeof className === "function" ? (state) => styles.root({ className: className(state) }) : styles.root({ className })}
      {...props}
    />
  );
}

function TabsList({ className, ...props }: Tabs.List.Props) {
  const styles = tabsStyles();
  return (
    <Tabs.List
      data-slot="tabs-list"
      className={typeof className === "function" ? (state) => styles.list({ className: className(state) }) : styles.list({ className })}
      {...props}
    />
  );
}

function TabsTab({ className, ...props }: Tabs.Tab.Props) {
  const styles = tabsStyles();
  return (
    <Tabs.Tab
      data-slot="tabs-tab"
      className={typeof className === "function" ? (state) => styles.tab({ className: className(state) }) : styles.tab({ className })}
      {...props}
    />
  );
}

function TabsIndicator({ className, ...props }: Tabs.Indicator.Props) {
  const styles = tabsStyles();
  return (
    <Tabs.Indicator
      data-slot="tabs-indicator"
      className={typeof className === "function" ? (state) => styles.indicator({ className: className(state) }) : styles.indicator({ className })}
      {...props}
    />
  );
}

function TabsPanel({ className, ...props }: Tabs.Panel.Props) {
  const styles = tabsStyles();
  return (
    <Tabs.Panel
      data-slot="tabs-panel"
      className={typeof className === "function" ? (state) => styles.panel({ className: className(state) }) : styles.panel({ className })}
      {...props}
    />
  );
}

export { TabsIndicator, TabsList, TabsPanel, TabsRoot, TabsTab, tabsStyles };
