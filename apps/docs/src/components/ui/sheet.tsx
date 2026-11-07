import type { ComponentProps } from "react";
import { Close, Content, Description, Overlay, Portal, Root, Title, Trigger } from "@radix-ui/react-dialog";

import { cn } from "@/lib/utils.ts";

function Sheet(props: ComponentProps<typeof Root>) {
  return <Root {...props} />;
}

function SheetTrigger(props: ComponentProps<typeof Trigger>) {
  return <Trigger {...props} />;
}

function SheetClose(props: ComponentProps<typeof Close>) {
  return <Close {...props} />;
}

function SheetContent({
  className,
  children,
  side = "left",
  ...props
}: ComponentProps<typeof Content> & { side?: "left" | "right" }) {
  return (
    <Portal>
      <Overlay className="fixed inset-0 z-40 bg-foreground/20" />
      <Content
        className={cn(
          "fixed z-50 flex h-full w-[17rem] flex-col gap-4 border-border bg-surface p-5 shadow-sm",
          side === "left" ? "inset-y-0 left-0 border-r" : "inset-y-0 right-0 border-l",
          className
        )}
        {...props}
      >
        {children}
      </Content>
    </Portal>
  );
}

function SheetHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex items-center justify-between gap-3", className)} {...props} />;
}

function SheetTitle(props: ComponentProps<typeof Title>) {
  return <Title className="text-sm font-semibold" {...props} />;
}

function SheetDescription(props: ComponentProps<typeof Description>) {
  return <Description className="sr-only" {...props} />;
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetDescription };
