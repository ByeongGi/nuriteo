import { tv } from "tailwind-variants";

export const teamManagementStyles = tv({
  slots: {
    toolbar: "rounded-lg border border-muted-border bg-surface p-4",
    list: "m-0 grid list-none gap-0 overflow-hidden rounded-lg border border-muted-border bg-surface p-0",
    row: "grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-muted-border px-4 py-3 last:border-b-0",
    identity: "grid min-w-0 gap-0.5",
    name: "truncate text-sm font-semibold text-foreground",
    metadata: "truncate text-xs text-muted-foreground",
    badge: "w-fit rounded-full bg-subtle px-2 py-1 text-xs font-medium text-muted-foreground",
    empty: "grid min-h-40 place-items-center rounded-lg border border-dashed border-muted-border bg-surface p-6 text-center text-sm text-muted-foreground",
    panel: "grid gap-5 rounded-lg border border-muted-border bg-surface p-5",
    form: "grid max-w-xl gap-4",
    actions: "flex flex-wrap gap-2",
    summary: "m-0 text-sm text-muted-foreground",
    feedback: "m-0 rounded-lg border border-muted-border bg-subtle px-4 py-3 text-sm",
    error: "m-0 rounded-lg border border-danger bg-danger-subtle px-4 py-3 text-sm text-danger",
    danger: "grid gap-4 rounded-lg border border-danger bg-danger-subtle p-5",
    navigation: "flex flex-wrap gap-2"
  }
});
