import { tv } from "tailwind-variants";

export const examplesStyles = tv({
  slots: {
    page:
      "mx-auto grid w-full max-w-[var(--n-layout-content-max)] gap-6 px-[var(--n-layout-content-gutter)] py-[clamp(2rem,7vw,5rem)] max-[24rem]:px-4",
    headerNote: "max-w-64 text-sm leading-relaxed text-muted-foreground sm:text-right",
    body: "grid min-w-0 gap-4",
    toolbar:
      "grid min-w-0 gap-3 rounded-xl border border-muted-border bg-surface p-4 sm:grid-cols-[minmax(14rem,1fr)_auto] sm:items-end max-[24rem]:p-3",
    search: "min-w-0",
    resultCount: "m-0 text-sm text-muted-foreground",
    grid:
      "grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,17rem),1fr))] gap-4 transition-opacity data-[filtering=true]:opacity-60 motion-reduce:transition-none",
    empty:
      "grid min-h-56 place-content-center gap-2 rounded-xl border border-dashed border-border bg-subtle p-6 text-center",
    emptyTitle: "m-0 text-lg font-semibold text-foreground",
    emptyDescription: "m-0 max-w-md text-sm leading-relaxed text-muted-foreground",
    card:
      "group grid min-h-64 min-w-0 content-between gap-8 rounded-xl border border-muted-border bg-surface p-5 transition-[border-color,background-color,translate] hover:-translate-y-0.5 hover:border-strong-border hover:bg-raised motion-reduce:transition-none max-[24rem]:min-h-56 max-[24rem]:p-4",
    cardMeta: "flex min-w-0 flex-wrap items-center justify-between gap-2",
    badge: "rounded-full bg-selected px-2.5 py-1 text-xs font-medium text-foreground",
    date: "text-xs text-subtle-foreground",
    cardTitle: "mt-5 mb-0 text-xl font-medium tracking-tight text-balance text-foreground",
    cardDescription: "mt-2 mb-0 text-sm leading-relaxed text-muted-foreground",
    cardLink: "inline-flex w-fit items-center gap-2 text-sm font-medium text-link underline-offset-4 group-hover:underline",
    breadcrumb: "flex min-w-0 flex-wrap items-center gap-1 text-sm text-muted-foreground",
    breadcrumbLink: "text-link underline-offset-4 hover:underline",
    detailCard: "overflow-hidden rounded-2xl border border-muted-border bg-surface shadow-sm",
    detailHero: "p-[clamp(1.5rem,5vw,4rem)]",
    detailMeta: "flex flex-wrap items-center gap-2",
    detailTitle:
      "mt-5 mb-0 text-[clamp(2rem,7vw,3.75rem)] font-medium leading-tight tracking-[-0.045em] text-balance text-foreground [overflow-wrap:anywhere]",
    detailDescription: "mt-4 mb-0 max-w-2xl text-base leading-relaxed text-muted-foreground",
    primaryLink:
      "mt-7 inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary no-underline transition-colors hover:bg-primary-strong max-[24rem]:w-full",
    facts: "grid gap-px bg-muted-border sm:grid-cols-3",
    fact: "min-w-0 bg-surface p-5",
    factLabel: "text-xs text-subtle-foreground",
    factValue: "mt-2 ml-0 [overflow-wrap:anywhere] font-medium text-foreground",
    readOnlyPage: "min-h-[calc(100vh-var(--n-layout-header-height))] bg-background",
    readOnlyInner:
      "mx-auto grid w-full max-w-[var(--n-layout-content-max)] gap-4 px-[var(--n-layout-content-gutter)] py-6 max-[24rem]:px-3 max-[24rem]:py-4",
    shell: "overflow-hidden rounded-xl border border-muted-border bg-surface shadow-lg",
    shellHeader:
      "flex flex-wrap items-start justify-between gap-4 border-b border-muted-border bg-raised px-5 py-4 max-[30rem]:px-4",
    shellTitle: "mt-2 mb-0 max-w-full text-lg font-medium tracking-tight text-foreground [overflow-wrap:anywhere]",
    shellMeta: "grid shrink-0 grid-cols-2 gap-x-5 gap-y-1 text-xs max-[30rem]:w-full",
    shellLayout: "grid min-h-[28rem] md:grid-cols-[15rem_minmax(0,1fr)]",
    shellAside: "min-w-0 border-b border-muted-border bg-sidebar p-4 md:border-r md:border-b-0",
    shellContent: "grid min-w-0 place-items-center p-6 md:p-10 max-[24rem]:p-4",
    shellContentInner: "w-full max-w-5xl min-w-0 text-center",
    actionRow: "mt-6 flex flex-wrap items-center justify-center gap-3 max-[24rem]:grid max-[24rem]:grid-cols-1",
    action: "max-[24rem]:w-full",
    forkState: "rounded-lg border border-muted-border bg-subtle p-4 text-left text-sm text-muted-foreground",
    forkForm: "grid gap-4 rounded-lg border border-muted-border bg-subtle p-4 text-left max-[24rem]:p-3",
    forkTitle: "m-0 text-base font-semibold text-foreground",
    forkDescription: "mt-1 mb-0 text-sm leading-relaxed text-muted-foreground",
    preview: "mt-8 border-t border-muted-border pt-7 text-left",
    previewHeader: "flex flex-wrap items-start justify-between gap-4",
    previewTitle: "m-0 text-base font-semibold text-foreground",
    previewDescription: "mt-1 mb-0 max-w-xl text-sm leading-relaxed text-muted-foreground",
    previewNotice: "mt-4 rounded-md border border-muted-border bg-subtle p-3 text-sm text-muted-foreground",
    previewError: "mt-4 rounded-md border border-danger/30 bg-danger-subtle p-3 text-sm text-danger",
    previewFrame: "mt-5 min-w-0 overflow-hidden rounded-lg border border-muted-border bg-white",
    previewIframe: "h-[min(34rem,70vh)] min-h-80 w-full border-0 bg-white",
    loadingPage:
      "mx-auto w-full max-w-[var(--n-layout-content-max)] px-[var(--n-layout-content-gutter)] py-12 md:py-20 max-[24rem]:px-4",
    loading: "grid gap-5",
    loadingLine: "h-3 animate-pulse rounded-full bg-subtle motion-reduce:animate-none",
    loadingEyebrow: "w-28",
    loadingTitle: "h-10 w-full max-w-md",
    loadingGrid: "grid grid-cols-[repeat(auto-fit,minmax(min(100%,17rem),1fr))] gap-4",
    loadingCard: "h-64 animate-pulse rounded-xl border border-muted-border bg-surface motion-reduce:animate-none"
  }
});
