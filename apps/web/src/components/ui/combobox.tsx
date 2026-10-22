"use client";

import { Combobox } from "@base-ui/react/combobox";
import { tv } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const comboboxStyles = tv({
  slots: {
    label: "mb-1 block text-sm font-medium text-foreground",
    inputGroup: "flex min-h-10 min-w-0 items-center gap-2 rounded-md border border-strong-border bg-surface px-3 shadow-xs transition-[border-color,box-shadow] focus-within:border-focus focus-within:ring-2 focus-within:ring-focus/20",
    input: "min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed",
    control: "grid size-7 shrink-0 place-items-center rounded text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus",
    positioner: "z-[110] outline-none",
    popup: "max-h-[min(22rem,var(--available-height))] w-[var(--anchor-width)] min-w-48 origin-[var(--transform-origin)] overflow-hidden rounded-lg border border-border bg-raised text-foreground shadow-overlay outline-none transition-[opacity,transform] duration-fast data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 motion-reduce:transition-none",
    list: "max-h-[min(20rem,var(--available-height))] overflow-y-auto p-1 overscroll-contain",
    item: "grid min-h-9 cursor-default grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-hover data-[selected]:font-semibold data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
    indicator: "grid size-4 place-items-center text-primary",
    status: "sr-only",
    empty: "px-3 py-6 text-center text-sm text-muted-foreground",
    groupLabel: "px-2.5 py-1.5 text-xs font-semibold text-muted-foreground",
    separator: "my-1 h-px bg-border",
    chips: "flex min-w-0 flex-wrap items-center gap-1.5",
    chip: "inline-flex min-h-7 items-center gap-1 rounded-md bg-subtle px-2 text-xs font-medium text-foreground",
    chipRemove: "grid size-5 place-items-center rounded text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus"
  }
});

const ComboboxRoot = Combobox.Root;
const ComboboxPortal = Combobox.Portal;
const ComboboxCollection = Combobox.Collection;
const ComboboxGroup = Combobox.Group;
const ComboboxRow = Combobox.Row;
const ComboboxValue = Combobox.Value;

function ComboboxLabel({ className, ...props }: Combobox.Label.Props) { const s = comboboxStyles(); return <Combobox.Label data-slot="combobox-label" className={resolveComponentClassName(className, (v) => s.label({ className: v }))} {...props} />; }
function ComboboxInputGroup({ className, ...props }: Combobox.InputGroup.Props) { const s = comboboxStyles(); return <Combobox.InputGroup data-slot="combobox-input-group" className={resolveComponentClassName(className, (v) => s.inputGroup({ className: v }))} {...props} />; }
function ComboboxInput({ className, ...props }: Combobox.Input.Props) { const s = comboboxStyles(); return <Combobox.Input data-slot="combobox-input" className={resolveComponentClassName(className, (v) => s.input({ className: v }))} {...props} />; }
function ComboboxTrigger({ className, ...props }: Combobox.Trigger.Props) { const s = comboboxStyles(); return <Combobox.Trigger data-slot="combobox-trigger" className={resolveComponentClassName(className, (v) => s.control({ className: v }))} {...props} />; }
function ComboboxClear({ className, ...props }: Combobox.Clear.Props) { const s = comboboxStyles(); return <Combobox.Clear data-slot="combobox-clear" className={resolveComponentClassName(className, (v) => s.control({ className: v }))} {...props} />; }
function ComboboxPositioner({ className, sideOffset = 4, ...props }: Combobox.Positioner.Props) { const s = comboboxStyles(); return <Combobox.Positioner data-slot="combobox-positioner" sideOffset={sideOffset} className={resolveComponentClassName(className, (v) => s.positioner({ className: v }))} {...props} />; }
function ComboboxPopup({ className, ...props }: Combobox.Popup.Props) { const s = comboboxStyles(); return <Combobox.Popup data-slot="combobox-popup" className={resolveComponentClassName(className, (v) => s.popup({ className: v }))} {...props} />; }
function ComboboxList({ className, ...props }: Combobox.List.Props) { const s = comboboxStyles(); return <Combobox.List data-slot="combobox-list" className={resolveComponentClassName(className, (v) => s.list({ className: v }))} {...props} />; }
function ComboboxItem({ className, ...props }: Combobox.Item.Props) { const s = comboboxStyles(); return <Combobox.Item data-slot="combobox-item" className={resolveComponentClassName(className, (v) => s.item({ className: v }))} {...props} />; }
function ComboboxItemIndicator({ className, ...props }: Combobox.ItemIndicator.Props) { const s = comboboxStyles(); return <Combobox.ItemIndicator data-slot="combobox-item-indicator" className={resolveComponentClassName(className, (v) => s.indicator({ className: v }))} {...props} />; }
function ComboboxStatus({ className, ...props }: Combobox.Status.Props) { const s = comboboxStyles(); return <Combobox.Status data-slot="combobox-status" className={resolveComponentClassName(className, (v) => s.status({ className: v }))} {...props} />; }
function ComboboxEmpty({ className, ...props }: Combobox.Empty.Props) { const s = comboboxStyles(); return <Combobox.Empty data-slot="combobox-empty" className={resolveComponentClassName(className, (v) => s.empty({ className: v }))} {...props} />; }
function ComboboxGroupLabel({ className, ...props }: Combobox.GroupLabel.Props) { const s = comboboxStyles(); return <Combobox.GroupLabel data-slot="combobox-group-label" className={resolveComponentClassName(className, (v) => s.groupLabel({ className: v }))} {...props} />; }
function ComboboxSeparator({ className, ...props }: Combobox.Separator.Props) { const s = comboboxStyles(); return <Combobox.Separator data-slot="combobox-separator" className={resolveComponentClassName(className, (v) => s.separator({ className: v }))} {...props} />; }
function ComboboxChips({ className, ...props }: Combobox.Chips.Props) { const s = comboboxStyles(); return <Combobox.Chips data-slot="combobox-chips" className={resolveComponentClassName(className, (v) => s.chips({ className: v }))} {...props} />; }
function ComboboxChip({ className, ...props }: Combobox.Chip.Props) { const s = comboboxStyles(); return <Combobox.Chip data-slot="combobox-chip" className={resolveComponentClassName(className, (v) => s.chip({ className: v }))} {...props} />; }
function ComboboxChipRemove({ className, ...props }: Combobox.ChipRemove.Props) { const s = comboboxStyles(); return <Combobox.ChipRemove data-slot="combobox-chip-remove" className={resolveComponentClassName(className, (v) => s.chipRemove({ className: v }))} {...props} />; }

export { ComboboxChip, ComboboxChipRemove, ComboboxChips, ComboboxClear, ComboboxCollection, ComboboxEmpty, ComboboxGroup, ComboboxGroupLabel, ComboboxInput, ComboboxInputGroup, ComboboxItem, ComboboxItemIndicator, ComboboxLabel, ComboboxList, ComboboxPopup, ComboboxPortal, ComboboxPositioner, ComboboxRoot, ComboboxRow, ComboboxSeparator, ComboboxStatus, ComboboxTrigger, ComboboxValue, comboboxStyles };
