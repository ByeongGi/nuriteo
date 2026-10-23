import { tv } from "tailwind-variants";

// Keep the shell's coordinated slots close to the sign-in route.
export const signInStyles = tv({
  slots: {
    page:
      "sign-in-page relative grid min-h-screen place-items-center overflow-hidden bg-[radial-gradient(circle_at_50%_24%,color-mix(in_srgb,var(--n-color-action-primary)_9%,transparent),transparent_24rem),linear-gradient(180deg,var(--n-color-bg-page),color-mix(in_srgb,var(--n-color-bg-subtle)_70%,var(--n-color-bg-page)))] p-6 text-foreground before:pointer-events-none before:absolute before:inset-0 before:bg-[radial-gradient(circle,color-mix(in_srgb,var(--n-color-border-strong)_34%,transparent)_0.75px,transparent_0.75px)] before:bg-[length:22px_22px] before:content-[''] before:[mask-image:linear-gradient(to_bottom,rgb(0_0_0_/_48%),transparent_44%)] max-[36rem]:p-3",
    window:
      "relative z-[1] grid min-h-[29rem] w-full max-w-[54rem] grid-cols-2 overflow-hidden rounded-2xl border border-muted-border bg-surface shadow-lg max-[36rem]:min-h-0 max-[36rem]:grid-cols-1",
    showcase:
      "relative isolate flex min-w-0 flex-col justify-between overflow-hidden bg-[radial-gradient(circle_at_78%_18%,rgb(255_255_255_/_18%),transparent_14rem),linear-gradient(145deg,var(--n-ref-color-cheonghwa-800),var(--n-ref-color-cheonghwa-600)_58%,var(--n-ref-color-indigo-700))] p-[clamp(1.75rem,4vw,2.25rem)] text-[#f7f9ff] [--sign-in-runtime-frame-height:12rem] [--sign-in-runtime-frame-width:19rem] before:pointer-events-none before:absolute before:right-[-7rem] before:bottom-20 before:h-[var(--sign-in-runtime-frame-height)] before:w-[var(--sign-in-runtime-frame-width)] before:rotate-[-3deg] before:rounded-2xl before:border before:border-white/18 before:bg-[radial-gradient(circle_at_1.25rem_1.15rem,rgb(255_255_255_/_42%)_0_0.16rem,transparent_0.18rem),radial-gradient(circle_at_2rem_1.15rem,rgb(255_255_255_/_28%)_0_0.16rem,transparent_0.18rem),radial-gradient(circle_at_2.75rem_1.15rem,rgb(255_255_255_/_20%)_0_0.16rem,transparent_0.18rem),linear-gradient(rgb(255_255_255_/_8%)_0_2.25rem,transparent_2.25rem),rgb(10_31_76_/_24%)] before:shadow-[0_1.5rem_4rem_rgb(5_15_38_/_18%)] before:content-[''] after:pointer-events-none after:absolute after:right-[-5.25rem] after:bottom-7 after:h-[calc(var(--sign-in-runtime-frame-height)*0.68)] after:w-[calc(var(--sign-in-runtime-frame-width)*0.82)] after:rotate-2 after:rounded-xl after:border after:border-white/16 after:bg-[linear-gradient(90deg,rgb(96_165_250_/_72%)_0_34%,transparent_34%_100%)_1.25rem_2.25rem/7.5rem_2px_no-repeat,linear-gradient(90deg,rgb(255_255_255_/_32%)_0_68%,transparent_68%_100%)_1.25rem_3.5rem/10rem_2px_no-repeat,linear-gradient(90deg,rgb(255_255_255_/_22%)_0_46%,transparent_46%_100%)_1.25rem_4.75rem/8.5rem_2px_no-repeat,linear-gradient(90deg,rgb(74_222_128_/_60%)_0_24%,transparent_24%_100%)_1.25rem_6rem/6rem_2px_no-repeat,rgb(7_20_48_/_54%)] after:shadow-[0_1rem_2.5rem_rgb(5_15_38_/_22%)] after:content-[''] max-[36rem]:min-h-40 max-[36rem]:p-5 max-[36rem]:[--sign-in-runtime-frame-height:9.5rem] max-[36rem]:[--sign-in-runtime-frame-width:15rem] max-[36rem]:before:right-[-5rem] max-[36rem]:before:bottom-8 max-[36rem]:after:right-[-3.5rem] max-[36rem]:after:bottom-2",
    brand:
      "relative z-[1] flex items-center gap-2 text-xs tracking-[0.1em]",
    brandMark:
      "grid size-7 place-items-center rounded-md bg-primary font-semibold shadow-[0_5px_14px_rgb(17_59_154_/_24%)]",
    summary:
      "relative z-[1] my-auto max-w-[13.5rem] text-[clamp(1.125rem,1.6vw,1.3rem)] font-semibold leading-[1.52] tracking-[-0.025em] text-balance text-white/94 [text-shadow:0_2px_16px_rgb(12_36_91_/_28%)] [word-break:keep-all] max-[36rem]:my-5 max-[36rem]:max-w-52 max-[36rem]:text-base max-[36rem]:leading-normal",
    meta:
      "relative z-[1] m-0 flex items-center gap-2 text-xs text-white/68",
    metaVersion: "inline-flex items-center gap-2 text-[inherit] text-inherit before:content-['·']",
    panel:
      "relative z-[1] flex min-w-0 flex-col justify-center bg-surface p-[clamp(1.75rem,4vw,2.75rem)] max-[36rem]:p-5 max-[22rem]:p-4",
    title:
      "mt-0 mb-6 text-[clamp(1.75rem,5vw,var(--n-font-size-2xl))] font-semibold leading-tight tracking-tight max-[36rem]:mb-4",
    oidc: "grid gap-3",
    oidcButton: "min-h-11 w-full min-w-0 gap-2 rounded-lg px-3",
    providerMark:
      "grid size-6 shrink-0 place-items-center rounded-sm bg-subtle text-xs",
    providerLabel: "min-w-0 text-balance [word-break:keep-all]",
    divider:
      "my-2 flex items-center gap-3 text-xs text-subtle-foreground before:h-px before:flex-1 before:bg-muted-border before:content-[''] after:h-px after:flex-1 after:bg-muted-border after:content-['']",
    form: "m-0 grid gap-4",
    field: "grid gap-2",
    label: "text-sm text-muted-foreground",
    input:
      "min-h-[2.875rem] rounded-lg border-border outline-none focus:border-focus focus:bg-surface focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--n-color-border-focus)_14%,transparent)]",
    submitButton: "min-h-11 w-full rounded-lg",
    error:
      "rounded-md border-0 bg-danger-subtle p-3 text-xs text-danger [&>p]:m-0 [&>p+p]:mt-2 [&>p+p]:font-mono [&>p+p]:text-muted-foreground",
    oidcError: "mb-3",
    status:
      "mb-4 rounded-lg border border-success/30 bg-success-subtle p-3 text-sm leading-relaxed text-success",
    providerError:
      "mb-4 grid gap-3 rounded-lg border border-warning/35 bg-warning-subtle p-3 text-xs leading-relaxed text-foreground [&>p]:m-0",
    help: "mt-5 mb-0 text-center text-xs text-subtle-foreground"
  }
});
