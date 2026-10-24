"use client";

import { DayFlag, DayPicker, getDefaultClassNames, SelectionState, UI } from "react-day-picker";
import type { ComponentProps } from "react";
import { ko } from "react-day-picker/locale";

type CalendarProps = ComponentProps<typeof DayPicker>;

const calendarClassNames = {
  [UI.Root]: "w-fit text-sm text-foreground",
  [UI.Months]: "flex flex-col",
  [UI.Month]: "space-y-3",
  [UI.MonthCaption]: "pointer-events-none relative flex h-9 items-center justify-center px-10",
  [UI.CaptionLabel]: "text-sm font-semibold",
  [UI.Nav]: "absolute inset-x-3 top-3 z-10 flex items-center justify-between",
  [UI.PreviousMonthButton]: "grid size-8 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-40",
  [UI.NextMonthButton]: "grid size-8 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-40",
  [UI.Chevron]: "size-4 fill-current",
  [UI.MonthGrid]: "border-collapse",
  [UI.Weekday]: "size-9 pb-1 text-center text-xs font-medium text-subtle-foreground",
  [UI.Week]: "border-0",
  [UI.Day]: "relative size-9 p-0 text-center",
  [UI.DayButton]: "grid size-9 place-items-center rounded-md text-sm outline-none transition-colors hover:bg-hover focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-focus",
  [SelectionState.selected]: "[&>button]:bg-primary [&>button]:font-semibold [&>button]:text-on-primary [&>button:hover]:bg-primary-strong",
  [DayFlag.today]: "[&>button]:font-semibold [&>button]:text-primary [&>button]:ring-1 [&>button]:ring-inset [&>button]:ring-primary/35",
  [DayFlag.outside]: "[&>button]:text-disabled-foreground [&>button]:opacity-55",
  [DayFlag.disabled]: "[&>button]:pointer-events-none [&>button]:text-disabled-foreground [&>button]:opacity-35",
  [DayFlag.hidden]: "invisible"
} as const;

function Calendar({ className, classNames, locale = ko, showOutsideDays = true, ...props }: CalendarProps) {
  const defaults = getDefaultClassNames();
  const resolveClassName = (key: keyof typeof calendarClassNames) => (
    [defaults[key], calendarClassNames[key], classNames?.[key]].filter(Boolean).join(" ")
  );

  return (
    <DayPicker
      data-slot="calendar"
      className={["p-3", className].filter(Boolean).join(" ")}
      classNames={{
        ...defaults,
        ...classNames,
        ...Object.fromEntries(
          Object.keys(calendarClassNames).map((key) => [key, resolveClassName(key as keyof typeof calendarClassNames)])
        )
      }}
      locale={locale}
      showOutsideDays={showOutsideDays}
      {...props}
    />
  );
}

export { Calendar };
export type { CalendarProps };
