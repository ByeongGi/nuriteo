"use client";

import { Field } from "@base-ui/react/field";
import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field";
import type { ReactNode } from "react";
import { tv } from "tailwind-variants";
import type { VariantProps } from "tailwind-variants";

import { fieldVariants } from "#src/components/ui/field.tsx";

const numberFieldStyles = tv({
  slots: {
    group: "grid grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] overflow-hidden rounded-md border border-strong-border bg-background focus-within:border-focus focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--n-color-border-focus)_18%,transparent)]",
    input: "min-h-10 min-w-0 border-0 bg-transparent px-2 text-center text-foreground outline-none disabled:cursor-not-allowed",
    stepper: "grid min-h-10 place-items-center bg-subtle text-muted-foreground outline-none transition-colors hover:bg-hover hover:text-foreground focus-visible:relative focus-visible:z-[1] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50",
    decrement: "border-r border-muted-border",
    increment: "border-l border-muted-border"
  },
  variants: {
    density: {
      compact: { input: "min-h-9", stepper: "min-h-9" },
      default: {}
    }
  },
  defaultVariants: { density: "default" }
});

type NumberFieldProps = Omit<NumberFieldPrimitive.Root.Props, "className"> &
  Pick<VariantProps<typeof fieldVariants>, "density" | "layout"> & {
    readonly className?: string;
    readonly description?: ReactNode;
    readonly error?: ReactNode;
    readonly label: ReactNode;
    readonly labelHidden?: boolean;
  };

function NumberField({ className, density, description, disabled, error, label, labelHidden = false, layout, name, ...rootProps }: NumberFieldProps) {
  const fieldStyles = fieldVariants({ density, layout });
  const styles = numberFieldStyles({ density });
  return (
    <Field.Root data-slot="field" className={fieldStyles.root({ className })} disabled={disabled} invalid={Boolean(error)} name={name}>
      <Field.Label className={fieldStyles.label({ className: labelHidden ? "sr-only" : undefined })}>{label}</Field.Label>
      <NumberFieldPrimitive.Root {...rootProps} disabled={disabled} name={name}>
        <NumberFieldPrimitive.Group className={styles.group()}>
          <NumberFieldPrimitive.Decrement aria-label="감소" className={styles.stepper({ className: styles.decrement() })}>−</NumberFieldPrimitive.Decrement>
          <NumberFieldPrimitive.Input className={styles.input()} />
          <NumberFieldPrimitive.Increment aria-label="증가" className={styles.stepper({ className: styles.increment() })}>+</NumberFieldPrimitive.Increment>
        </NumberFieldPrimitive.Group>
      </NumberFieldPrimitive.Root>
      {description ? <Field.Description className={fieldStyles.description()}>{description}</Field.Description> : null}
      {error ? <Field.Error className={fieldStyles.error()} match>{error}</Field.Error> : null}
    </Field.Root>
  );
}

export { NumberField, numberFieldStyles };
export type { NumberFieldProps };
