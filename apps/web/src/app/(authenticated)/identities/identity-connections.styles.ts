import { tv } from "tailwind-variants";

const identityConnectionsStyles = tv({
  slots: {
    root: "grid w-full min-w-0 gap-6",
    callout: "grid gap-1 rounded-xl border border-muted-border border-l-[3px] border-l-primary bg-surface p-4",
    calloutTitle: "text-sm font-semibold text-foreground",
    calloutDescription: "m-0 text-sm leading-relaxed text-muted-foreground",
    panel: "min-w-0 overflow-hidden rounded-xl border border-muted-border bg-surface shadow-xs",
    panelHeader: "flex flex-wrap items-start justify-between gap-3 border-b border-muted-border px-5 py-4",
    panelHeading: "grid min-w-0 gap-1",
    panelTitle: "m-0 text-lg font-semibold tracking-tight",
    panelDescription: "m-0 text-sm leading-relaxed text-muted-foreground",
    count: "shrink-0 rounded-full bg-subtle px-2.5 py-1 text-xs font-medium text-muted-foreground",
    empty: "grid min-h-48 place-content-center justify-items-center gap-2 p-6 text-center",
    emptyTitle: "font-semibold text-foreground",
    emptyDescription: "text-sm leading-relaxed text-muted-foreground",
    list: "m-0 grid list-none p-0",
    item: "flex min-w-0 items-start justify-between gap-4 border-t border-muted-border px-5 py-4 first:border-t-0 max-[32rem]:items-stretch max-[32rem]:flex-col",
    itemCopy: "grid min-w-0 gap-1",
    itemTitle: "font-semibold text-foreground",
    itemMeta: "text-sm text-muted-foreground",
    itemDetail: "text-xs leading-relaxed text-subtle-foreground",
    action: "shrink-0 max-[32rem]:w-full",
    feedback: "sticky top-3 z-[var(--n-z-sticky)] m-0 rounded-lg border px-4 py-3 text-sm shadow-md",
    feedbackError: "border-danger/40 bg-danger-subtle text-danger",
    feedbackSuccess: "border-success/40 bg-success-subtle text-success"
  }
});

export { identityConnectionsStyles };
