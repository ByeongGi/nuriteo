"use client";

import { Tooltip } from "@base-ui/react/tooltip";
import { tv } from "tailwind-variants";

const tooltipStyles = tv({
  slots: {
    positioner: "z-[120]",
    popup: "max-w-64 origin-[var(--transform-origin)] rounded-md bg-foreground px-2.5 py-1.5 text-xs leading-relaxed text-background shadow-overlay transition-[opacity,transform] duration-fast data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 motion-reduce:transition-none",
    arrow: "flex text-foreground data-[side=bottom]:-top-2 data-[side=left]:-right-2 data-[side=right]:-left-2 data-[side=top]:-bottom-2"
  }
});

const TooltipProvider = Tooltip.Provider;
const TooltipRoot = Tooltip.Root;
const TooltipTrigger = Tooltip.Trigger;

function TooltipPositioner({ className, sideOffset = 8, ...props }: Tooltip.Positioner.Props) {
  const styles = tooltipStyles();
  return (
    <Tooltip.Positioner
      data-slot="tooltip-positioner"
      sideOffset={sideOffset}
      className={typeof className === "function" ? (state) => styles.positioner({ className: className(state) }) : styles.positioner({ className })}
      {...props}
    />
  );
}

function TooltipPopup({ className, ...props }: Tooltip.Popup.Props) {
  const styles = tooltipStyles();
  return (
    <Tooltip.Popup
      data-slot="tooltip-popup"
      className={typeof className === "function" ? (state) => styles.popup({ className: className(state) }) : styles.popup({ className })}
      {...props}
    />
  );
}

function TooltipArrow({ className, ...props }: Tooltip.Arrow.Props) {
  const styles = tooltipStyles();
  return (
    <Tooltip.Arrow
      data-slot="tooltip-arrow"
      className={typeof className === "function" ? (state) => styles.arrow({ className: className(state) }) : styles.arrow({ className })}
      {...props}
    >
      <svg aria-hidden="true" width="16" height="8" viewBox="0 0 16 8">
        <path fill="currentColor" d="M0 8 6.6 1.4a2 2 0 0 1 2.8 0L16 8Z" />
      </svg>
    </Tooltip.Arrow>
  );
}

function TooltipContent({ children, ...props }: Tooltip.Positioner.Props) {
  return (
    <Tooltip.Portal>
      <TooltipPositioner {...props}>
        <TooltipPopup>
          <TooltipArrow />
          {children}
        </TooltipPopup>
      </TooltipPositioner>
    </Tooltip.Portal>
  );
}

export {
  TooltipArrow,
  TooltipContent,
  TooltipPopup,
  TooltipPositioner,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
  tooltipStyles
};
