import { tv } from "tailwind-variants";

const buttonVariants = tv({
  base: "inline-flex min-h-10 items-center justify-center gap-2 whitespace-nowrap rounded-md border px-4 text-sm font-medium transition-colors duration-fast outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
  variants: {
    variant: {
      primary: "border-primary bg-primary text-on-primary shadow-xs hover:bg-primary-strong active:bg-primary-active",
      secondary: "border-strong-border bg-surface text-foreground hover:bg-hover active:bg-active",
      ghost: "border-transparent bg-transparent text-foreground hover:bg-hover active:bg-active",
      danger: "border-danger bg-danger text-on-danger hover:brightness-110"
    },
    size: {
      sm: "min-h-9 px-3 text-xs",
      md: "min-h-10 px-4 text-sm",
      lg: "min-h-11 px-5 text-base",
      icon: "size-10 p-0"
    }
  },
  defaultVariants: {
    size: "md",
    variant: "secondary"
  }
});

export { buttonVariants };
