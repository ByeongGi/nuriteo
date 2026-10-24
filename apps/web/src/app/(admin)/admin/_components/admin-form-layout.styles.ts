import { tv } from "tailwind-variants";

export const adminFormStyles = tv({
  slots: {
    form: "grid min-w-0 gap-0",
    section:
      "col-span-full grid min-w-0 grid-cols-[minmax(10rem,0.34fr)_minmax(0,1fr)] gap-[clamp(var(--n-ref-space-4),3vw,var(--n-ref-space-7))] border-t border-muted-border py-4 first:border-t-0 first:pt-0 max-[52rem]:grid-cols-1 max-[52rem]:gap-3",
    sectionHeader: "self-start",
    sectionTitle: "m-0 text-sm font-semibold text-foreground",
    sectionDescription:
      "mt-1 mb-0 text-xs leading-relaxed text-subtle-foreground text-pretty",
    fields:
      "grid min-w-0 grid-cols-2 items-start gap-3 [&>fieldset]:col-span-full max-[36rem]:grid-cols-1 max-[36rem]:[&>*]:col-span-1",
    fieldSpan: "col-span-full min-w-0 max-w-[48rem]",
    actions:
      "col-span-full flex items-center justify-between gap-4 border-t border-muted-border pt-4 max-[52rem]:flex-col max-[52rem]:items-stretch [&_[data-slot=button]]:min-w-28 [&_[data-slot=button]]:shrink-0 max-[52rem]:[&_[data-slot=button]]:w-full",
    actionNote:
      "m-0 max-w-[42rem] text-xs leading-relaxed text-subtle-foreground",
    emptyState:
      "grid min-h-32 place-content-center gap-2 rounded-md border border-dashed border-border bg-subtle p-5 text-center",
    emptyTitle: "text-foreground",
    emptyDescription: "m-0 text-sm text-muted-foreground"
  },
  variants: {
    layout: {
      flush: {},
      panel: { form: "border-t border-muted-border p-5" }
    },
    orientation: {
      split: {},
      stacked: {
        section: "grid-cols-1 gap-4",
        sectionHeader: "max-w-[42rem]",
        sectionDescription: "max-w-[40rem]"
      }
    }
  },
  defaultVariants: { layout: "flush", orientation: "split" }
});
