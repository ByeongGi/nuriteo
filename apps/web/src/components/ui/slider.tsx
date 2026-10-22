"use client";

import { Slider } from "@base-ui/react/slider";
import { tv } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const sliderStyles = tv({
  slots: {
    root: "grid min-w-0 gap-2 data-[orientation=vertical]:h-48 data-[orientation=vertical]:grid-cols-[auto_1fr]",
    header: "flex items-center justify-between gap-3 text-sm",
    label: "font-medium text-foreground",
    value: "tabular-nums text-muted-foreground",
    control: "flex h-5 touch-none items-center py-2 data-[orientation=vertical]:h-full data-[orientation=vertical]:w-5 data-[orientation=vertical]:justify-center data-[orientation=vertical]:px-2 data-[orientation=vertical]:py-0",
    track: "h-1.5 w-full rounded-full bg-subtle data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5",
    indicator: "rounded-full bg-primary",
    thumb: "size-4 rounded-full border-2 border-primary bg-surface shadow-sm outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[dragging]:scale-110 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
  }
});

function SliderRoot<Value extends number | readonly number[]>({ className, ...props }: Slider.Root.Props<Value>) {
  const styles = sliderStyles();
  return <Slider.Root<Value> data-slot="slider" className={resolveComponentClassName(className, (override) => styles.root({ className: override }))} {...props} />;
}

function SliderLabel({ className, ...props }: Slider.Label.Props) { const s = sliderStyles(); return <Slider.Label data-slot="slider-label" className={resolveComponentClassName(className, (v) => s.label({ className: v }))} {...props} />; }
function SliderValue({ className, ...props }: Slider.Value.Props) { const s = sliderStyles(); return <Slider.Value data-slot="slider-value" className={resolveComponentClassName(className, (v) => s.value({ className: v }))} {...props} />; }
function SliderControl({ className, ...props }: Slider.Control.Props) { const s = sliderStyles(); return <Slider.Control data-slot="slider-control" className={resolveComponentClassName(className, (v) => s.control({ className: v }))} {...props} />; }
function SliderTrack({ className, ...props }: Slider.Track.Props) { const s = sliderStyles(); return <Slider.Track data-slot="slider-track" className={resolveComponentClassName(className, (v) => s.track({ className: v }))} {...props} />; }
function SliderIndicator({ className, ...props }: Slider.Indicator.Props) { const s = sliderStyles(); return <Slider.Indicator data-slot="slider-indicator" className={resolveComponentClassName(className, (v) => s.indicator({ className: v }))} {...props} />; }
function SliderThumb({ className, ...props }: Slider.Thumb.Props) { const s = sliderStyles(); return <Slider.Thumb data-slot="slider-thumb" className={resolveComponentClassName(className, (v) => s.thumb({ className: v }))} {...props} />; }
function SliderHeader({ className, ...props }: React.ComponentProps<"div">) { const s = sliderStyles(); return <div data-slot="slider-header" className={s.header({ className })} {...props} />; }

export { SliderControl, SliderHeader, SliderIndicator, SliderLabel, SliderRoot, SliderThumb, SliderTrack, SliderValue, sliderStyles };
