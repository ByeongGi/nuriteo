import { tv } from "tailwind-variants";

export const homeEntryStyles = tv({
  slots: {
    page: "relative isolate min-h-[calc(100vh-4rem)] overflow-hidden bg-background text-foreground",
    glow:
      "pointer-events-none absolute inset-x-0 top-0 -z-10 h-[34rem] bg-[radial-gradient(circle_at_70%_18%,color-mix(in_srgb,var(--n-color-action-primary)_18%,transparent),transparent_38%),radial-gradient(circle_at_12%_8%,color-mix(in_srgb,var(--n-color-status-info)_10%,transparent),transparent_30%)]",
    inner:
      "mx-auto grid w-full max-w-[82rem] gap-[clamp(3rem,7vw,6rem)] px-[var(--n-layout-content-gutter)] py-[clamp(3.5rem,8vw,7rem)]",
    hero: "grid items-center gap-[clamp(2.5rem,6vw,5rem)] lg:grid-cols-[minmax(0,0.88fr)_minmax(32rem,1.12fr)]",
    copy: "max-w-[42rem]",
    eyebrow:
      "mb-5 inline-flex items-center gap-2 rounded-full border border-muted-border bg-surface/80 px-3 py-1.5 text-xs font-semibold tracking-[0.04em] text-link shadow-xs backdrop-blur",
    eyebrowDot: "size-1.5 rounded-full bg-success shadow-[0_0_0_4px_var(--n-color-status-success-subtle)]",
    title:
      "m-0 text-[clamp(2.75rem,6.3vw,5.3rem)] font-semibold leading-[0.98] tracking-[-0.068em] text-balance [word-break:keep-all]",
    lead:
      "mt-7 max-w-[38rem] text-[clamp(1rem,1.7vw,1.25rem)] leading-[1.75] text-muted-foreground [word-break:keep-all]",
    actions: "mt-9 flex flex-wrap items-center gap-3",
    primaryAction:
      "inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-primary bg-primary px-6 text-sm font-semibold text-on-primary no-underline shadow-md transition-[background-color,transform,box-shadow] hover:-translate-y-0.5 hover:bg-primary-strong hover:shadow-lg active:translate-y-0 motion-reduce:transform-none motion-reduce:transition-none",
    secondaryAction:
      "inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-strong-border bg-surface/80 px-6 text-sm font-semibold text-foreground no-underline shadow-xs backdrop-blur transition-colors hover:bg-hover",
    evidence: "m-0 mt-8 flex list-none flex-wrap gap-x-5 gap-y-2 p-0 text-xs text-subtle-foreground",
    evidenceItem: "inline-flex items-center gap-2 before:size-1 before:rounded-full before:bg-primary before:content-['']",
    product:
      "relative m-0 min-w-0 overflow-hidden rounded-2xl border border-muted-border bg-[#0b1220] shadow-[0_30px_80px_rgb(5_15_35_/_22%)] ring-1 ring-white/5",
    productBar: "flex h-12 items-center justify-between border-b border-white/10 px-4 text-[0.7rem] text-white/50",
    windowDots: "flex gap-1.5 [&>i]:size-2 [&>i]:rounded-full [&>i]:bg-white/20",
    productStatus: "inline-flex items-center gap-2 before:size-1.5 before:rounded-full before:bg-[#47d788] before:content-['']",
    productBody: "grid min-h-[27rem] grid-cols-[11rem_minmax(0,1fr)] max-[38rem]:grid-cols-[7.5rem_minmax(0,1fr)]",
    explorer: "border-r border-white/10 bg-[#0d1626] p-3 text-xs text-white/56",
    explorerTitle: "mb-3 flex items-center justify-between text-[0.65rem] font-semibold tracking-[0.12em] text-white/55",
    file: "flex min-h-8 items-center gap-2 rounded-md px-2",
    activeFile: "bg-[#244b93] text-white",
    editor: "min-w-0 bg-[#0a111d]",
    editorTab: "flex h-10 items-center gap-2 border-b border-white/10 px-4 text-xs text-white/76",
    syntaxLanguage: "text-[#79a7ff]",
    code: "grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 overflow-hidden p-5 font-mono text-[0.74rem] leading-7 text-white/66 max-[38rem]:p-3 max-[38rem]:text-[0.63rem]",
    lineNumbers: "select-none text-right text-white/48",
    codeText: "whitespace-pre",
    codeKeyword: "text-[#dd8fff]",
    codeString: "text-[#8cd6ac]",
    codeAccent: "text-[#79a7ff]",
    productFooter: "flex items-center justify-between border-t border-white/10 px-4 py-3 text-[0.68rem] text-white/45",
    live: "inline-flex items-center gap-2 text-[#77dfa2] before:size-1.5 before:rounded-full before:bg-[#47d788] before:content-['']",
    foundation: "grid gap-6 border-t border-muted-border pt-[clamp(2rem,5vw,4rem)]",
    foundationHeader: "grid gap-2 md:grid-cols-[0.8fr_1.2fr] md:items-end",
    foundationTitle: "m-0 text-[clamp(1.75rem,3vw,2.6rem)] font-semibold tracking-[-0.045em]",
    foundationDescription: "m-0 max-w-[40rem] text-sm leading-7 text-muted-foreground md:justify-self-end",
    featureGrid: "grid gap-3 md:grid-cols-3",
    feature:
      "grid min-h-48 content-between rounded-xl border border-muted-border bg-surface p-5 shadow-xs transition-[border-color,transform] hover:-translate-y-0.5 hover:border-strong-border motion-reduce:transform-none",
    featureIndex: "text-xs font-semibold tracking-[0.1em] text-link",
    featureTitle: "mb-0 mt-8 text-lg font-semibold tracking-[-0.025em]",
    featureDescription: "mb-0 mt-2 text-sm leading-6 text-muted-foreground"
  }
});
