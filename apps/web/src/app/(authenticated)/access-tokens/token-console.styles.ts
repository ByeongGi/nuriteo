import { tv } from "tailwind-variants";

const tokenConsoleStyles = tv({
  slots: {
    root: "grid w-full min-w-0 gap-4",
    panel: "grid min-w-0 gap-4 rounded-lg border border-muted-border bg-surface p-4",
    issuePanel: "bg-raised",
    secret: "border-warning/40 bg-warning-subtle",
    headingRow: "flex min-w-0 flex-wrap items-start justify-between gap-3",
    heading: "grid min-w-0 gap-1",
    eyebrow: "m-0 text-xs font-semibold text-accent-foreground",
    title: "m-0 text-base font-semibold tracking-tight text-foreground",
    titleCount: "ml-1 text-xs font-medium text-muted-foreground",
    description: "m-0 text-sm leading-relaxed text-muted-foreground",
    secretCode: "block min-w-0 select-all overflow-x-auto rounded-lg border border-warning/30 bg-raised p-3 font-mono text-sm [overflow-wrap:anywhere]",
    actions: "flex flex-wrap justify-end gap-2 max-[30rem]:[&>*]:w-full",
    form: "grid gap-4 sm:grid-cols-[minmax(0,1fr)_16rem]",
    formActions: "col-span-full flex justify-end gap-2 max-[30rem]:[&>*]:flex-1",
    permissionPreset: "col-span-full",
    advancedPermissions: "col-span-full border-muted-border bg-transparent",
    advancedSummary: "flex items-center gap-2 text-xs font-normal text-muted-foreground",
    advancedContent: "p-3",
    scopes: "m-0 grid min-w-0 grid-cols-2 gap-2 border-0 p-0 max-[42rem]:grid-cols-1",
    toolbar: "grid items-end gap-2 border-b border-muted-border pb-3 md:grid-cols-[minmax(14rem,1fr)_auto]",
    search: "min-w-0",
    empty: "grid min-h-36 place-content-center justify-items-center gap-1.5 rounded-md bg-subtle/50 p-6 text-center",
    emptyTitle: "font-semibold text-foreground",
    emptyDescription: "m-0 max-w-[34rem] text-sm leading-relaxed text-muted-foreground",
    list: "m-0 grid max-h-[38rem] list-none overflow-auto p-0 [scrollbar-gutter:stable]",
    item: "flex min-w-0 items-start justify-between gap-4 border-t border-muted-border px-2 py-3 first:border-t-0 hover:bg-hover max-[42rem]:items-stretch max-[42rem]:flex-col",
    itemCopy: "grid min-w-0 gap-1",
    itemTitle: "font-semibold text-foreground",
    itemMeta: "text-sm leading-relaxed text-muted-foreground",
    itemDetail: "text-xs leading-relaxed text-subtle-foreground [overflow-wrap:anywhere]",
    recordActions: "flex shrink-0 flex-wrap items-center justify-end gap-2 max-[30rem]:[&>*]:flex-1",
    feedback: "sticky top-3 z-[var(--n-z-sticky)] m-0 rounded-lg border px-4 py-3 text-sm shadow-md",
    feedbackError: "border-danger/40 bg-danger-subtle text-danger",
    feedbackSuccess: "border-success/40 bg-success-subtle text-success"
  },
  variants: {
    embedded: {
      true: {
        root: "gap-3",
        panel: "border-x-0 border-b-0 px-0 pb-0",
        heading: "px-1"
      },
      false: {}
    }
  },
  defaultVariants: { embedded: false }
});

export { tokenConsoleStyles };
