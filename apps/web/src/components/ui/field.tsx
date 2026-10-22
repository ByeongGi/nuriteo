"use client";

import { Field } from "@base-ui/react/field";
import { Select } from "@base-ui/react/select";
import { useId } from "react";
import type {
  ReactNode,
  TextareaHTMLAttributes
} from "react";
import { tv } from "tailwind-variants";
import type { VariantProps } from "tailwind-variants";

const fieldVariants = tv({
  slots: {
    root: "grid min-w-0 gap-1",
    label: "text-sm font-medium text-foreground",
    control:
      "w-full min-w-0 min-h-10 rounded-md border border-strong-border bg-background px-2 font-[inherit] text-foreground outline-none transition-[border-color,box-shadow,background-color] duration-fast enabled:hover:border-focus focus-visible:border-focus focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--n-color-border-focus)_18%,transparent)] disabled:cursor-not-allowed disabled:opacity-65",
    description: "m-0 text-xs font-normal leading-relaxed text-subtle-foreground",
    error: "m-0 text-xs font-medium leading-relaxed text-danger"
  },
  variants: {
    density: {
      compact: { control: "min-h-9" },
      default: {}
    },
    layout: {
      inline: {
        root: "grid-cols-[minmax(8rem,0.32fr)_minmax(0,1fr)] items-center gap-x-4 max-[36rem]:grid-cols-1",
        description: "col-start-2 max-[36rem]:col-start-auto",
        error: "col-start-2 max-[36rem]:col-start-auto"
      },
      stacked: {}
    }
  },
  defaultVariants: {
    density: "default",
    layout: "stacked"
  }
});

type SharedFieldProps = VariantProps<typeof fieldVariants> & {
  readonly className?: string;
  readonly description?: ReactNode;
  readonly error?: ReactNode;
  readonly label: ReactNode;
  readonly labelHidden?: boolean;
};

type TextFieldProps = Omit<Field.Control.Props, "className"> & SharedFieldProps & {
  readonly controlClassName?: string;
};

function FieldMessages({ description, descriptionClassName, error, errorClassName }: Pick<SharedFieldProps, "description" | "error"> & {
  readonly descriptionClassName: string;
  readonly errorClassName: string;
}) {
  return (
    <>
      {description ? <Field.Description className={descriptionClassName}>{description}</Field.Description> : null}
      {error ? <Field.Error className={errorClassName} match>{error}</Field.Error> : null}
    </>
  );
}

function TextField({
  className,
  controlClassName,
  density,
  description,
  disabled,
  error,
  label,
  labelHidden = false,
  layout,
  name,
  ...controlProps
}: TextFieldProps) {
  const styles = fieldVariants({ density, layout });
  return (
    <Field.Root
      data-slot="field"
      className={styles.root({ className })}
      disabled={disabled}
      invalid={Boolean(error)}
      name={name}
    >
      <Field.Label className={styles.label({ className: labelHidden ? "sr-only" : undefined })}>{label}</Field.Label>
      <Field.Control className={styles.control({ className: controlClassName })} disabled={disabled} {...controlProps} />
      <FieldMessages description={description} descriptionClassName={styles.description()} error={error} errorClassName={styles.error()} />
    </Field.Root>
  );
}

interface SelectOption {
  readonly disabled?: boolean;
  readonly label: ReactNode;
  readonly value: string;
}

const selectFieldStyles = tv({
  slots: {
    trigger: "flex items-center justify-between gap-2 text-left",
    value: "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap data-[placeholder]:text-subtle-foreground",
    icon: "grid size-4 shrink-0 place-items-center text-muted-foreground leading-none transition-transform duration-fast [&>svg]:block group-data-[popup-open]:rotate-180",
    positioner: "z-[var(--n-z-popover)]",
    popup:
      "w-max min-w-[max(var(--anchor-width),10rem)] max-w-[calc(100vw-2rem)] max-h-[min(20rem,var(--available-height))] origin-[var(--transform-origin)] overflow-auto rounded-md border border-strong-border bg-surface text-foreground shadow-lg transition-[opacity,transform] duration-fast data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0",
    list: "max-h-[inherit] overflow-y-auto p-1 overscroll-contain",
    item: "grid min-h-9 cursor-default grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 whitespace-nowrap rounded-sm px-2 py-1 text-sm text-foreground outline-none data-[highlighted]:bg-subtle data-[selected]:font-semibold data-[selected]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:text-disabled-foreground [&>:last-child]:whitespace-nowrap",
    indicator: "text-xs text-accent-foreground",
    scrollArrow: "grid h-6 place-items-center bg-surface text-xs text-muted-foreground [&>svg]:block"
  }
});

type SelectFieldProps = SharedFieldProps & {
  readonly autoComplete?: string;
  readonly defaultValue?: string;
  readonly disabled?: boolean;
  readonly form?: string;
  readonly id?: string;
  readonly name?: string;
  readonly onValueChange?: (value: string) => void;
  readonly options: readonly SelectOption[];
  readonly placeholder?: ReactNode;
  readonly readOnly?: boolean;
  readonly required?: boolean;
  readonly triggerClassName?: string;
  readonly value?: string;
};

function SelectField({
  autoComplete,
  className,
  defaultValue,
  density,
  description,
  disabled,
  error,
  form,
  id: providedId,
  label,
  labelHidden = false,
  layout,
  name,
  onValueChange,
  options,
  placeholder = "선택하세요",
  readOnly,
  required,
  triggerClassName,
  value
}: SelectFieldProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const fieldStyles = fieldVariants({ density, layout });
  const selectStyles = selectFieldStyles();

  return (
    <Field.Root
      data-slot="field"
      className={fieldStyles.root({ className })}
      disabled={disabled}
      invalid={Boolean(error)}
      name={name}
    >
      <Field.Label
        className={fieldStyles.label({ className: labelHidden ? "sr-only" : undefined })}
        nativeLabel={false}
        render={<span />}
      >
        {label}
      </Field.Label>
      <Select.Root
        autoComplete={autoComplete}
        defaultValue={defaultValue === "" ? null : defaultValue}
        disabled={disabled}
        form={form}
        id={id}
        items={options}
        name={name}
        readOnly={readOnly}
        required={required}
        value={value === "" ? null : value}
        onValueChange={(nextValue) => {
          if (nextValue !== null) onValueChange?.(nextValue);
        }}
      >
        <Select.Trigger className={fieldStyles.control({ className: selectStyles.trigger({ className: ["group", triggerClassName].filter(Boolean).join(" ") }) })}>
          <Select.Value className={selectStyles.value()} placeholder={placeholder} />
          <Select.Icon className={selectStyles.icon()} aria-hidden="true">
            <ChevronIcon />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner className={selectStyles.positioner()} sideOffset={4} alignItemWithTrigger={false}>
            <Select.Popup className={selectStyles.popup()}>
              <Select.ScrollUpArrow className={selectStyles.scrollArrow()}><ChevronIcon direction="up" /></Select.ScrollUpArrow>
              <Select.List className={selectStyles.list()}>
                {options.map((option) => (
                  <Select.Item
                    className={selectStyles.item()}
                    disabled={option.disabled}
                    key={option.value}
                    value={option.value}
                  >
                    <Select.ItemIndicator className={selectStyles.indicator()}>✓</Select.ItemIndicator>
                    <Select.ItemText>{option.label}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.List>
              <Select.ScrollDownArrow className={selectStyles.scrollArrow()}><ChevronIcon /></Select.ScrollDownArrow>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
      <FieldMessages description={description} descriptionClassName={fieldStyles.description()} error={error} errorClassName={fieldStyles.error()} />
    </Field.Root>
  );
}

function ChevronIcon({ direction = "down" }: { readonly direction?: "down" | "up" }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      style={direction === "up" ? { transform: "rotate(180deg)" } : undefined}
    >
      <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type TextareaFieldProps = TextareaHTMLAttributes<HTMLTextAreaElement> & SharedFieldProps;

function TextareaField({
  className,
  density,
  description,
  error,
  id: providedId,
  label,
  labelHidden = false,
  layout,
  ...textareaProps
}: TextareaFieldProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const styles = fieldVariants({ density, layout });

  return (
    <Field.Root
      data-slot="field"
      className={styles.root({ className })}
      disabled={textareaProps.disabled}
      invalid={Boolean(error)}
      name={textareaProps.name}
    >
      <Field.Label className={styles.label({ className: labelHidden ? "sr-only" : undefined })} htmlFor={id}>{label}</Field.Label>
      <textarea className={styles.control({ className: "min-h-28 resize-y py-2" })} id={id} {...textareaProps} />
      <FieldMessages description={description} descriptionClassName={styles.description()} error={error} errorClassName={styles.error()} />
    </Field.Root>
  );
}

export { SelectField, TextareaField, TextField, fieldVariants, selectFieldStyles };
export type { SelectFieldProps, SelectOption, TextareaFieldProps, TextFieldProps };
