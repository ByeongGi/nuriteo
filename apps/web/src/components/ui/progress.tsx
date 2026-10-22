"use client";

import { Progress } from "@base-ui/react/progress";
import { tv } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const progressStyles = tv({
  slots: {
    root: "grid min-w-0 gap-2",
    header: "flex items-center justify-between gap-3 text-sm",
    label: "font-medium text-foreground",
    value: "tabular-nums text-muted-foreground",
    track: "h-2 overflow-hidden rounded-full bg-subtle",
    indicator: "h-full rounded-full bg-primary transition-[width] duration-normal data-[status=indeterminate]:animate-pulse motion-reduce:transition-none"
  }
});

function ProgressRoot({ className, ...props }: Progress.Root.Props) {
  const styles = progressStyles();
  return <Progress.Root data-slot="progress" className={resolveComponentClassName(className, (override) => styles.root({ className: override }))} {...props} />;
}

function ProgressLabel({ className, ...props }: Progress.Label.Props) {
  const styles = progressStyles();
  return <Progress.Label data-slot="progress-label" className={resolveComponentClassName(className, (override) => styles.label({ className: override }))} {...props} />;
}

function ProgressValue({ className, ...props }: Progress.Value.Props) {
  const styles = progressStyles();
  return <Progress.Value data-slot="progress-value" className={resolveComponentClassName(className, (override) => styles.value({ className: override }))} {...props} />;
}

function ProgressTrack({ className, ...props }: Progress.Track.Props) {
  const styles = progressStyles();
  return <Progress.Track data-slot="progress-track" className={resolveComponentClassName(className, (override) => styles.track({ className: override }))} {...props} />;
}

function ProgressIndicator({ className, ...props }: Progress.Indicator.Props) {
  const styles = progressStyles();
  return <Progress.Indicator data-slot="progress-indicator" className={resolveComponentClassName(className, (override) => styles.indicator({ className: override }))} {...props} />;
}

function ProgressHeader({ className, ...props }: React.ComponentProps<"div">) {
  const styles = progressStyles();
  return <div data-slot="progress-header" className={styles.header({ className })} {...props} />;
}

export { ProgressHeader, ProgressIndicator, ProgressLabel, ProgressRoot, ProgressTrack, ProgressValue, progressStyles };
