"use client";

import { Radio } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import type { ReactNode } from "react";
import { tv } from "tailwind-variants";
import type { VariantProps } from "tailwind-variants";

const radioGroupStyles = tv({
  slots: {
    fieldset: "m-0 grid min-w-0 gap-3 border-0 p-0",
    legend: "mb-1 text-sm font-semibold text-foreground",
    description: "-mt-2 mb-1 text-xs leading-relaxed text-subtle-foreground",
    group: "grid gap-3",
    option:
      "flex cursor-pointer items-start gap-3 rounded-md border border-muted-border bg-surface p-3 transition-colors hover:border-strong-border has-[[data-checked]]:border-primary has-[[data-checked]]:bg-selected has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:opacity-50",
    control:
      "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-strong-border bg-surface outline-none data-[checked]:border-primary focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    indicator: "size-2 rounded-full bg-primary",
    copy: "grid min-w-0 gap-1",
    optionLabel: "font-medium leading-5 text-foreground",
    optionDescription: "text-xs leading-relaxed text-subtle-foreground"
  },
  variants: {
    layout: {
      columns: { group: "grid-cols-2 max-[40rem]:grid-cols-1" },
      stacked: {}
    }
  },
  defaultVariants: { layout: "stacked" }
});

interface RadioCardOption<Value extends string> {
  readonly description?: ReactNode;
  readonly disabled?: boolean;
  readonly label: ReactNode;
  readonly value: Value;
}

interface RadioCardGroupProps<Value extends string> extends VariantProps<typeof radioGroupStyles> {
  readonly description?: ReactNode;
  readonly disabled?: boolean;
  readonly label: ReactNode;
  readonly name: string;
  readonly onValueChange: (value: Value) => void;
  readonly options: readonly RadioCardOption<Value>[];
  readonly value: Value;
}

function RadioCardGroup<Value extends string>({ description, disabled, label, layout, name, onValueChange, options, value }: RadioCardGroupProps<Value>) {
  const styles = radioGroupStyles({ layout });
  return (
    <fieldset className={styles.fieldset()}>
      <legend className={styles.legend()}>{label}</legend>
      {description ? <p className={styles.description()}>{description}</p> : null}
      <RadioGroupPrimitive className={styles.group()} disabled={disabled} name={name} value={value} onValueChange={onValueChange}>
        {options.map((option) => (
          <label className={styles.option()} key={option.value}>
            <Radio.Root className={styles.control()} value={option.value} disabled={option.disabled}>
              <Radio.Indicator className={styles.indicator()} />
            </Radio.Root>
            <span className={styles.copy()}>
              <span className={styles.optionLabel()}>{option.label}</span>
              {option.description ? <span className={styles.optionDescription()}>{option.description}</span> : null}
            </span>
          </label>
        ))}
      </RadioGroupPrimitive>
    </fieldset>
  );
}

function RadioGroupRoot(props: RadioGroupPrimitive.Props) {
  return <RadioGroupPrimitive {...props} />;
}

function RadioControl(props: Radio.Root.Props) {
  return <Radio.Root {...props} />;
}

function RadioIndicator(props: Radio.Indicator.Props) {
  return <Radio.Indicator {...props} />;
}

export { RadioCardGroup, RadioControl, RadioGroupRoot, RadioIndicator, radioGroupStyles };
export type { RadioCardGroupProps, RadioCardOption };
