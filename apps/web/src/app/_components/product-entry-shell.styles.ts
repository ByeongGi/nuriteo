import { tv } from "tailwind-variants";

export const productEntryStyles = tv({
  slots: {
    page:
      "grid min-h-[calc(100vh-var(--n-layout-header-height))] place-items-center bg-[radial-gradient(circle_at_8%_12%,color-mix(in_srgb,var(--n-color-action-primary)_9%,transparent),transparent_26rem)] bg-page p-[clamp(1rem,4vw,3rem)] text-foreground max-[32rem]:p-0",
    window:
      "grid min-h-[min(44rem,calc(100vh-var(--n-layout-header-height)-4rem))] w-full max-w-[72rem] grid-cols-[minmax(20rem,1.05fr)_minmax(26rem,0.95fr)] overflow-hidden rounded-2xl border border-muted-border bg-surface shadow-lg max-[52rem]:min-h-0 max-[52rem]:grid-cols-1 max-[32rem]:min-h-[calc(100vh-var(--n-layout-header-height))] max-[32rem]:rounded-none max-[32rem]:border-0",
    showcase:
      "relative isolate flex min-w-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_78%_18%,rgb(255_255_255_/_18%),transparent_14rem),linear-gradient(145deg,var(--n-ref-color-cheonghwa-800),var(--n-ref-color-cheonghwa-600)_58%,var(--n-ref-color-indigo-700))] p-[clamp(2rem,5vw,4rem)] text-on-primary after:absolute after:-right-32 after:-bottom-40 after:size-[28rem] after:rounded-full after:border after:border-white/15 after:shadow-[0_0_0_4rem_rgb(255_255_255_/_4%),0_0_0_9rem_rgb(255_255_255_/_3%)] after:content-[''] max-[52rem]:min-h-52 max-[52rem]:p-5 max-[32rem]:min-h-40",
    brand: "relative z-[1] flex items-center gap-3 text-sm tracking-wide",
    brandMark:
      "grid size-9 place-items-center rounded-md border border-white/25 bg-white/10 font-semibold",
    message: "relative z-[1] my-auto max-w-[31rem] max-[52rem]:my-8 max-[52rem]:mb-0",
    eyebrow: "m-0 text-xs font-semibold tracking-wide text-white/70",
    heading:
      "mt-4 max-w-[10ch] text-[clamp(2.5rem,5vw,4.25rem)] font-medium leading-[1.04] tracking-[-0.055em] text-balance text-on-primary max-[52rem]:mt-2 max-[52rem]:max-w-none max-[52rem]:text-[clamp(1.75rem,8vw,2.5rem)]",
    detail:
      "mt-5 block max-w-[29rem] text-base leading-relaxed text-white/75 max-[52rem]:hidden",
    status:
      "relative z-[1] m-0 flex items-center gap-2 text-xs text-white/75 max-[52rem]:hidden",
    statusMark:
      "size-2 rounded-full bg-success shadow-[0_0_0_4px_color-mix(in_srgb,var(--n-color-status-success)_18%,transparent)]",
    card:
      "flex min-w-0 flex-col justify-center bg-surface p-[clamp(2rem,6vw,4.5rem)] max-[52rem]:p-6 max-[32rem]:px-5",
    cardCompact: "",
    header: "grid gap-3",
    cardEyebrow: "m-0 text-xs font-semibold tracking-wide text-accent-foreground",
    title:
      "m-0 max-w-[14ch] text-[clamp(2rem,4vw,3.25rem)] font-semibold leading-tight tracking-tight text-balance",
    description: "m-0 max-w-[34rem] text-sm leading-relaxed text-muted-foreground",
    loadingLine: "h-3 animate-pulse rounded-full bg-subtle motion-reduce:animate-none",
    loadingShort: "mt-2 w-24",
    loadingTitle: "mt-5 h-10 w-3/4",
    loadingBody: "mt-5 w-full"
  }
});
