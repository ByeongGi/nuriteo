import { tv } from "tailwind-variants";

const mfaSecurityStyles = tv({
  slots: {
    root: "grid w-full min-w-0 gap-4",
    productBar: "flex min-h-15 w-full flex-wrap items-center justify-between gap-3 border-b border-muted-border bg-surface px-[clamp(1rem,4vw,2rem)] py-2 max-[42rem]:items-stretch max-[42rem]:flex-col",
    productBrand: "flex items-center gap-2 rounded-md p-2 font-semibold text-foreground no-underline",
    brandMark: "grid size-7 place-items-center rounded-md bg-primary text-xs font-bold text-on-primary",
    productStatus: "text-sm text-muted-foreground",
    productNav: "flex flex-wrap items-center gap-1 max-[30rem]:grid max-[30rem]:grid-cols-1",
    productLink: "rounded-md px-3 py-2 text-sm font-medium text-muted-foreground no-underline hover:bg-hover hover:text-foreground aria-[current=page]:bg-selected aria-[current=page]:text-foreground",
    notice: "grid gap-1 rounded-md border border-warning/40 bg-warning-subtle p-3",
    noticeDanger: "border-danger/40 bg-danger-subtle",
    noticeTitle: "font-semibold text-foreground",
    noticeDescription: "m-0 text-sm leading-relaxed text-muted-foreground",
    card: "grid min-w-0 gap-3 rounded-lg border border-muted-border bg-surface p-4 [&>h2]:m-0 [&>h2]:text-base [&>h2]:font-semibold [&>p]:m-0 [&>p]:text-sm [&>p]:leading-relaxed [&>p]:text-muted-foreground",
    cardAction: "mt-1 justify-self-end max-[30rem]:w-full",
    grid: "grid min-w-0 gap-3",
    enrollmentGrid: "grid min-w-0 grid-cols-2 items-start gap-4 max-[42rem]:grid-cols-1",
    enrollmentSecret: "grid min-w-0 gap-2",
    label: "text-xs font-medium text-subtle-foreground",
    secret: "block min-w-0 select-all rounded-md bg-subtle p-3 font-mono text-sm [overflow-wrap:anywhere]",
    qr: "aspect-square w-full max-w-72 rounded-lg border border-muted-border bg-white p-2",
    codeForm: "mt-1 grid gap-3 [&>label]:text-sm [&>label]:font-medium [&_[data-slot=button]]:justify-self-end max-[30rem]:[&_[data-slot=button]]:w-full",
    recovery: "border-warning/40",
    recoveryList: "m-0 grid list-none grid-cols-2 gap-2 p-0 max-[32rem]:grid-cols-1",
    recoveryItem: "min-w-0 rounded-md bg-subtle px-3 py-2",
    recoveryCode: "select-all font-mono text-sm [overflow-wrap:anywhere]",
    actions: "mt-1 flex flex-wrap items-center justify-end gap-2 max-[32rem]:items-stretch max-[32rem]:flex-col max-[32rem]:[&>*]:w-full",
    feedback: "sticky top-3 z-[var(--n-z-sticky)] m-0 rounded-lg border px-4 py-3 text-sm shadow-md",
    feedbackError: "border-danger/40 bg-danger-subtle text-danger",
    feedbackSuccess: "border-success/40 bg-success-subtle text-success",
    safeNavigation: "flex flex-wrap items-center justify-end gap-3 border-t border-muted-border pt-5 max-[30rem]:items-stretch max-[30rem]:flex-col"
  },
  variants: {
    standalone: {
      true: { root: "mx-auto max-w-[64rem] px-[clamp(1rem,4vw,3.5rem)] pb-[clamp(2rem,6vw,4rem)]" },
      false: {}
    }
  },
  defaultVariants: { standalone: false }
});

export { mfaSecurityStyles };
