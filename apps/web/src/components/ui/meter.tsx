"use client";

import { Meter } from "@base-ui/react/meter";
import { tv } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const meterStyles = tv({
  slots: {
    root: "grid min-w-0 gap-2",
    header: "flex items-center justify-between gap-3 text-sm",
    label: "font-medium text-foreground",
    value: "tabular-nums text-muted-foreground",
    track: "h-2 overflow-hidden rounded-full bg-subtle",
    indicator: "h-full rounded-full bg-primary transition-[width] duration-normal motion-reduce:transition-none"
  }
});

function MeterRoot({ className, ...props }: Meter.Root.Props) {
  const styles = meterStyles();
  return <Meter.Root data-slot="meter" className={resolveComponentClassName(className, (override) => styles.root({ className: override }))} {...props} />;
}

function MeterLabel({ className, ...props }: Meter.Label.Props) {
  const styles = meterStyles();
  return <Meter.Label data-slot="meter-label" className={resolveComponentClassName(className, (override) => styles.label({ className: override }))} {...props} />;
}

function MeterValue({ className, ...props }: Meter.Value.Props) {
  const styles = meterStyles();
  return <Meter.Value data-slot="meter-value" className={resolveComponentClassName(className, (override) => styles.value({ className: override }))} {...props} />;
}

function MeterTrack({ className, ...props }: Meter.Track.Props) {
  const styles = meterStyles();
  return <Meter.Track data-slot="meter-track" className={resolveComponentClassName(className, (override) => styles.track({ className: override }))} {...props} />;
}

function MeterIndicator({ className, ...props }: Meter.Indicator.Props) {
  const styles = meterStyles();
  return <Meter.Indicator data-slot="meter-indicator" className={resolveComponentClassName(className, (override) => styles.indicator({ className: override }))} {...props} />;
}

function MeterHeader({ className, ...props }: React.ComponentProps<"div">) {
  const styles = meterStyles();
  return <div data-slot="meter-header" className={styles.header({ className })} {...props} />;
}

export { MeterHeader, MeterIndicator, MeterLabel, MeterRoot, MeterTrack, MeterValue, meterStyles };
