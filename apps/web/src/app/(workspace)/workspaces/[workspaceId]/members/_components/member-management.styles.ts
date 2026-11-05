import { tv } from "tailwind-variants";

export const memberManagementStyles = tv({
  slots: {
    toolbar: "grid gap-3 rounded-lg border border-muted-border bg-surface p-4 md:grid-cols-[minmax(0,1fr)_12rem]",
    summary: "m-0 text-sm text-muted-foreground",
    list: "m-0 grid list-none gap-0 overflow-hidden rounded-lg border border-muted-border bg-surface p-0",
    row: "grid min-h-16 grid-cols-[minmax(0,1fr)_8rem_auto] items-center gap-4 border-b border-muted-border px-4 py-3 last:border-b-0 max-[42rem]:grid-cols-[minmax(0,1fr)_auto]",
    identity: "grid min-w-0 gap-0.5",
    name: "truncate text-sm font-semibold text-foreground",
    metadata: "truncate text-xs text-muted-foreground",
    role: "w-fit rounded-full bg-subtle px-2 py-1 text-xs font-medium text-muted-foreground max-[42rem]:col-start-1",
    empty: "grid min-h-40 place-items-center rounded-lg border border-dashed border-muted-border bg-surface p-6 text-center text-sm text-muted-foreground",
    panel: "grid gap-5 rounded-lg border border-muted-border bg-surface p-5",
    panelCopy: "m-0 max-w-2xl text-sm leading-relaxed text-muted-foreground",
    form: "grid max-w-xl gap-4",
    status: "m-0 rounded-lg border border-muted-border bg-subtle px-4 py-3 text-sm",
    error: "m-0 rounded-lg border border-danger bg-danger-subtle px-4 py-3 text-sm text-danger",
    actions: "flex flex-wrap gap-2",
    csvPreview: "max-h-64 overflow-auto whitespace-pre rounded-md bg-subtle p-4 text-xs text-muted-foreground",
    danger: "grid gap-4 rounded-lg border border-danger bg-danger-subtle p-5"
  }
});
