import { tv } from "tailwind-variants";

export const adminPageHeaderStyles = tv({
  slots: {
    root:
      "m-0 grid max-w-[54rem] grid-cols-[minmax(0,1fr)_auto] items-end gap-6 max-[52rem]:grid-cols-1 max-[52rem]:items-start",
    copy: "min-w-0",
    breadcrumb:
      "mb-3 flex items-center gap-2 text-xs text-subtle-foreground [&_a]:text-muted-foreground [&_a]:no-underline hover:[&_a]:text-link hover:[&_a]:underline hover:[&_a]:underline-offset-[0.2em]",
    title:
      "m-0 text-balance text-[clamp(2rem,4vw,3rem)] leading-[1.08] tracking-[-0.045em]",
    description:
      "mt-3 mb-0 max-w-[48rem] text-pretty leading-[1.65] text-muted-foreground",
    content: "min-w-0",
    aside:
      "flex min-w-32 items-center justify-end max-[52rem]:justify-start [&>*]:inline-flex [&>*]:min-h-8 [&>*]:items-center [&>*]:whitespace-nowrap [&>*]:rounded-full [&>*]:border [&>*]:border-muted-border [&>*]:bg-raised [&>*]:px-3 [&>*]:text-xs [&>*]:font-semibold [&>*]:text-muted-foreground"
  }
});
