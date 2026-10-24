"use client";

import { Field } from "@base-ui/react/field";
import { format } from "date-fns";
import { ko } from "date-fns/locale";
import { useId, useState } from "react";
import type { ReactNode } from "react";
import type { VariantProps } from "tailwind-variants";

import { Calendar } from "#src/components/ui/calendar.tsx";
import { fieldVariants } from "#src/components/ui/field.tsx";
import { PopoverPopup, PopoverPortal, PopoverPositioner, PopoverRoot, PopoverTrigger } from "#src/components/ui/popover.tsx";

type DatePickerFieldProps = VariantProps<typeof fieldVariants> & {
  readonly className?: string;
  readonly description?: ReactNode;
  readonly disabled?: boolean;
  readonly label: ReactNode;
  readonly labelHidden?: boolean;
  readonly max?: Date;
  readonly min?: Date;
  readonly name?: string;
  readonly onValueChange: (value: Date) => void;
  readonly required?: boolean;
  readonly value?: Date;
};

function DatePickerField({
  className,
  density,
  description,
  disabled,
  label,
  labelHidden = false,
  layout,
  max,
  min,
  name,
  onValueChange,
  required,
  value
}: DatePickerFieldProps) {
  const generatedId = useId();
  const triggerId = `${generatedId}-trigger`;
  const labelId = `${generatedId}-label`;
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => value ?? min ?? new Date());
  const styles = fieldVariants({ density, layout });
  const disabledDates = [
    ...(min ? [{ before: min }] : []),
    ...(max ? [{ after: max }] : [])
  ];

  return (
    <Field.Root data-slot="field" className={styles.root({ className })} disabled={disabled} name={name}>
      <Field.Label
        className={styles.label({ className: labelHidden ? "sr-only" : undefined })}
        id={labelId}
        nativeLabel={false}
        render={<span />}
      >
        {label}
      </Field.Label>
      <input name={name} type="hidden" value={value ? format(value, "yyyy-MM-dd") : ""} />
      <PopoverRoot open={open} triggerId={triggerId} onOpenChange={setOpen}>
        <PopoverTrigger
          aria-labelledby={labelId}
          aria-required={required || undefined}
          className={styles.control({ className: "group flex items-center gap-2 text-left" })}
          disabled={disabled}
          id={triggerId}
          type="button"
          onClick={() => {
            if (!open) setVisibleMonth(value ?? min ?? new Date());
          }}
        >
          <CalendarIcon />
          <span className={value ? "min-w-0 flex-1 truncate" : "min-w-0 flex-1 truncate text-subtle-foreground"}>
            {value ? format(value, "PPP", { locale: ko }) : "날짜 선택"}
          </span>
          <ChevronIcon />
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverPositioner align="start" sideOffset={6}>
            <PopoverPopup className="w-auto p-0">
              <Calendar
                {...(disabledDates.length > 0 ? { disabled: disabledDates } : {})}
                {...(max ? { endMonth: max } : {})}
                month={visibleMonth}
                mode="single"
                {...(value ? { selected: value } : {})}
                {...(min ? { startMonth: min } : {})}
                onMonthChange={setVisibleMonth}
                onSelect={(nextValue) => {
                  if (!nextValue) return;
                  onValueChange(nextValue);
                  setOpen(false);
                }}
              />
            </PopoverPopup>
          </PopoverPositioner>
        </PopoverPortal>
      </PopoverRoot>
      {description ? <Field.Description className={styles.description()}>{description}</Field.Description> : null}
    </Field.Root>
  );
}

function CalendarIcon() {
  return (
    <svg aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" fill="none" viewBox="0 0 16 16">
      <path d="M4.5 1.75v2.5m7-2.5v2.5M2.25 6h11.5m-10.5-3h9.5a1 1 0 0 1 1 1v8.75a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.25" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[popup-open]:rotate-180" fill="none" viewBox="0 0 16 16">
      <path d="m4 6 4 4 4-4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </svg>
  );
}

export { DatePickerField };
export type { DatePickerFieldProps };
