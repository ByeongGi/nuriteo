import { tv } from "tailwind-variants";

export const backupConsoleStyles = tv({
  slots: {
    formBody: "col-span-full border-t border-muted-border p-5 max-[40rem]:p-4",
    sectionTitle: "inline-flex items-center gap-2.5",
    sectionIndex: "grid size-5 shrink-0 place-items-center rounded border border-muted-border bg-subtle text-[0.6875rem] font-semibold text-muted-foreground",
    toggle: "col-span-full min-w-0 max-w-[42rem]",
    scheduleList:
      "col-span-full grid min-w-0",
    settingRow:
      "flex min-w-0 flex-wrap items-center justify-between gap-4 border-t border-muted-border py-3 first:border-t-0",
    settingCopy: "grid min-w-[12rem] flex-1 gap-0.5",
    settingControls: "flex min-w-0 flex-wrap items-end justify-end gap-2 max-[34rem]:w-full max-[34rem]:justify-start",
    scheduleNumber: "w-32 shrink-0",
    scheduleTime: "w-36 shrink-0",
    timeZoneField: "w-64 min-w-0 max-w-full",
    retentionGrid:
      "col-span-full grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))] gap-x-8",
    metricCard:
      "flex min-w-0 flex-wrap items-center justify-between gap-4 border-t border-muted-border py-3",
    metricCopy: "grid min-w-[12rem] flex-1 gap-0.5",
    metricTitle: "text-sm font-medium text-foreground",
    metricDescription: "text-xs leading-relaxed text-subtle-foreground",
    metricControl: "flex min-w-0 items-center justify-start gap-2",
    metricNumber: "w-32 shrink-0",
    metricUnit: "min-w-8 text-xs font-medium text-muted-foreground",
    retentionControl: "flex min-w-0 items-center justify-between gap-3",
    retentionNumber: "w-28 shrink-0",
    operationsGrid:
      "col-span-full grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-x-8",
    drillPanel:
      "col-span-full grid min-w-0 gap-4 border-t border-muted-border pt-4",
    drillHeader: "grid gap-0.5",
    drillTitle: "text-sm font-medium text-foreground",
    drillDescription: "text-xs leading-relaxed text-subtle-foreground",
    drillGrid:
      "grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] items-start gap-3"
  }
});
