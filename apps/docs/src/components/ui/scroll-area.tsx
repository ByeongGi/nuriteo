import type { ComponentProps } from "react";
import { Corner, Scrollbar, Root, Thumb, Viewport } from "@radix-ui/react-scroll-area";

import { cn } from "@/lib/utils.ts";

function ScrollArea({
  className,
  children,
  ...props
}: ComponentProps<typeof Root>) {
  return (
    <Root className={cn("relative overflow-hidden", className)} {...props}>
      <Viewport className="size-full rounded-[inherit]">{children}</Viewport>
      <ScrollBar />
      <Corner />
    </Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ComponentProps<typeof Scrollbar>) {
  return (
    <Scrollbar
      orientation={orientation}
      className={cn(
        "flex touch-none p-px select-none",
        orientation === "vertical" && "h-full w-2.5 border-l border-l-transparent",
        orientation === "horizontal" && "h-2.5 flex-col border-t border-t-transparent",
        className
      )}
      {...props}
    >
      <Thumb className="relative flex-1 rounded-full bg-border" />
    </Scrollbar>
  );
}

export { ScrollArea };
