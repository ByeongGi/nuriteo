import { tv } from "tailwind-variants";

// Keep the shell's coordinated slots close to the sign-in route.
export const signInStyles = tv({
  slots: {
    page: "sign-in-page relative grid min-h-screen place-items-center overflow-hidden p-6 text-foreground max-[36rem]:p-3",
    window:
      "sign-in-window relative z-[1] grid min-h-[29rem] w-full max-w-[54rem] grid-cols-2 overflow-hidden rounded-2xl border border-muted-border bg-surface shadow-lg max-[36rem]:min-h-0 max-[36rem]:grid-cols-1",
    showcase:
      "sign-in-showcase relative isolate flex min-w-0 flex-col justify-between overflow-hidden p-[clamp(1.75rem,4vw,2.25rem)] text-[#f7f9ff] max-[36rem]:min-h-40 max-[36rem]:p-5",
    brand:
      "sign-in-showcase__brand relative z-[1] flex items-center gap-2 text-xs tracking-[0.1em]",
    brandMark:
      "grid size-7 place-items-center rounded-md bg-primary font-semibold shadow-[0_5px_14px_rgb(17_59_154_/_24%)]",
    summary:
      "sign-in-showcase__summary relative z-[1] my-auto max-w-[13.5rem] text-[clamp(1.125rem,1.6vw,1.3rem)] font-semibold leading-[1.52] tracking-[-0.025em] text-balance text-white/94 [text-shadow:0_2px_16px_rgb(12_36_91_/_28%)] [word-break:keep-all] max-[36rem]:my-5 max-[36rem]:max-w-52 max-[36rem]:text-base max-[36rem]:leading-normal",
    meta:
      "sign-in-showcase__meta relative z-[1] m-0 flex items-center gap-2 text-xs text-white/68",
    metaVersion: "inline-flex items-center gap-2 text-[inherit] text-inherit before:content-['·']",
    panel:
      "sign-in-panel relative z-[1] flex min-w-0 flex-col justify-center bg-surface p-[clamp(1.75rem,4vw,2.75rem)] max-[36rem]:p-5",
    title:
      "mb-6 text-[clamp(1.75rem,5vw,var(--n-font-size-2xl))] font-semibold leading-tight tracking-tight max-[36rem]:mb-4",
    oidc: "grid gap-3",
    oidcButton: "w-full gap-2 rounded-lg",
    providerMark:
      "grid size-6 place-items-center rounded-sm bg-subtle text-xs",
    divider:
      "my-2 flex items-center gap-3 text-xs text-subtle-foreground before:h-px before:flex-1 before:bg-muted-border before:content-[''] after:h-px after:flex-1 after:bg-muted-border after:content-['']",
    form: "sign-in-form grid gap-4",
    field: "field-group",
    label: "text-sm text-muted-foreground",
    input:
      "min-h-[2.875rem] rounded-lg border-border outline-none focus:border-focus focus:bg-surface focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--n-color-border-focus)_14%,transparent)]",
    submitButton: "w-full rounded-lg",
    error:
      "form-error border-0 bg-danger-subtle text-xs text-danger",
    oidcError: "mb-3",
    help: "mt-5 mb-0 text-center text-xs text-subtle-foreground"
  }
});
