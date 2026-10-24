import type { ComponentProps } from "react";
import { tv } from "tailwind-variants";
import type { VariantProps } from "tailwind-variants";

const styles = tv({
  slots: {
    page: "mx-auto grid w-full content-start gap-4 px-6 py-5 max-[48rem]:px-4 max-[48rem]:py-4",
    panel: "rounded-md border border-muted-border bg-surface p-4",
    section: "overflow-hidden rounded-md border border-muted-border bg-surface",
    heading: "mb-3 flex min-h-7 items-center justify-between gap-3 [&_h2]:m-0 [&_h2]:text-sm [&_h2]:font-semibold [&_p]:m-0",
    record: "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-md border border-muted-border bg-surface px-4 py-3 max-[48rem]:grid-cols-1 max-[48rem]:items-start [&>div:first-child]:grid [&>div:first-child]:min-w-0 [&>div:first-child]:gap-1 [&>div:first-child>span]:text-xs [&>div:first-child>span]:text-muted-foreground [&_small]:block [&_small]:text-xs [&_small]:text-muted-foreground [&_small]:[overflow-wrap:anywhere]",
    actions: "col-start-2 row-start-1 flex flex-wrap justify-end gap-2 max-[48rem]:col-start-1 max-[48rem]:row-auto max-[48rem]:justify-stretch max-[48rem]:[&>*]:flex-1",
    full: "col-span-full",
    sectionHeading: "flex min-h-13 items-center justify-between gap-4 px-4 py-3 max-[37.5rem]:flex-col max-[37.5rem]:items-stretch [&_h2]:m-0 [&_h2]:text-sm [&_h2]:font-semibold [&_p]:m-0 [&_p]:max-w-[32rem] [&_p]:text-right [&_p]:text-xs [&_p]:leading-5 [&_p]:text-muted-foreground max-[37.5rem]:[&>p]:text-left",
    summary: "flex flex-wrap items-center gap-2 text-xs text-muted-foreground",
    card: "grid gap-3 rounded-md border border-muted-border bg-surface p-4",
    note: "m-0 text-sm leading-6 text-muted-foreground",
    metricGrid: "grid grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-2",
    feedback: "m-0 flex items-center gap-3 rounded-md border bg-subtle px-4 py-3 text-sm"
  },
  variants: {
    contentWidth: {
      narrow: { page: "max-w-[64rem]" },
      standard: { page: "max-w-[72rem]" },
      wide: { page: "max-w-[90rem]" }
    },
    feedbackTone: {
      danger: { feedback: "border-danger text-danger" },
      neutral: { feedback: "border-muted-border text-foreground" },
      success: { feedback: "border-success text-foreground" }
    }
  },
  defaultVariants: {
    contentWidth: "standard"
  }
});

const css = styles();

type AdminPageProps = ComponentProps<"main"> & Pick<VariantProps<typeof styles>, "contentWidth">;

export function AdminPage({ className, contentWidth, ...props }: AdminPageProps) {
  const pageStyles = styles({ contentWidth });
  return <main {...props} className={pageStyles.page({ className })} />;
}
export function AdminPanel(props: ComponentProps<"section">) { return <section {...props} className={css.panel({ className: props.className })} />; }
export function AdminSection(props: ComponentProps<"section">) { return <section {...props} className={css.section({ className: props.className })} />; }
export function AdminCollectionHeading(props: ComponentProps<"div">) { return <div {...props} className={css.heading({ className: props.className })} />; }
export function AdminIntegrationRecord(props: ComponentProps<"li">) { return <li {...props} className={css.record({ className: props.className })} />; }
export function AdminRecordActions(props: ComponentProps<"div">) { return <div {...props} className={css.actions({ className: props.className })} />; }
export function AdminFullWidth(props: ComponentProps<"div">) { return <div {...props} className={css.full({ className: props.className })} />; }
export function AdminSectionHeading(props: ComponentProps<"header">) { return <header {...props} className={css.sectionHeading({ className: props.className })} />; }
export function AdminSummary(props: ComponentProps<"div">) { return <div {...props} className={css.summary({ className: props.className })} />; }
export function AdminCard(props: ComponentProps<"section">) { return <section {...props} className={css.card({ className: props.className })} />; }
export function AdminNote(props: ComponentProps<"p">) { return <p {...props} className={css.note({ className: props.className })} />; }
export function AdminMetricGrid(props: ComponentProps<"div">) { return <div {...props} className={css.metricGrid({ className: props.className })} />; }
type AdminFeedbackProps = ComponentProps<"p"> & Pick<VariantProps<typeof styles>, "feedbackTone">;
export function AdminFeedback({ className, feedbackTone = "neutral", ...props }: AdminFeedbackProps) {
  const feedbackStyles = styles({ feedbackTone });
  return <p {...props} className={feedbackStyles.feedback({ className })} />;
}
