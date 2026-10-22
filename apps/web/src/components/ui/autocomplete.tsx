"use client";

import { Autocomplete } from "@base-ui/react/autocomplete";

import {
  ComboboxClear as AutocompleteClear,
  ComboboxCollection as AutocompleteCollection,
  ComboboxEmpty as AutocompleteEmpty,
  ComboboxGroup as AutocompleteGroup,
  ComboboxGroupLabel as AutocompleteGroupLabel,
  ComboboxInput as AutocompleteInput,
  ComboboxInputGroup as AutocompleteInputGroup,
  ComboboxList as AutocompleteList,
  ComboboxPopup as AutocompletePopup,
  ComboboxPositioner as AutocompletePositioner,
  ComboboxRow as AutocompleteRow,
  ComboboxStatus as AutocompleteStatus,
  comboboxStyles as autocompleteStyles
} from "#src/components/ui/combobox.tsx";
import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const AutocompleteRoot = Autocomplete.Root;
const AutocompletePortal = Autocomplete.Portal;
const AutocompleteValue = Autocomplete.Value;

function AutocompleteTrigger({ className, ...props }: Autocomplete.Trigger.Props) { const s = autocompleteStyles(); return <Autocomplete.Trigger data-slot="autocomplete-trigger" className={resolveComponentClassName(className, (v) => s.control({ className: v }))} {...props} />; }
function AutocompleteItem({ className, ...props }: Autocomplete.Item.Props) { const s = autocompleteStyles(); return <Autocomplete.Item data-slot="autocomplete-item" className={resolveComponentClassName(className, (v) => s.item({ className: v }))} {...props} />; }
function AutocompleteSeparator({ className, ...props }: Autocomplete.Separator.Props) { const s = autocompleteStyles(); return <Autocomplete.Separator data-slot="autocomplete-separator" className={resolveComponentClassName(className, (v) => s.separator({ className: v }))} {...props} />; }

export { AutocompleteClear, AutocompleteCollection, AutocompleteEmpty, AutocompleteGroup, AutocompleteGroupLabel, AutocompleteInput, AutocompleteInputGroup, AutocompleteItem, AutocompleteList, AutocompletePopup, AutocompletePortal, AutocompletePositioner, AutocompleteRoot, AutocompleteRow, AutocompleteSeparator, AutocompleteStatus, AutocompleteTrigger, AutocompleteValue, autocompleteStyles };
