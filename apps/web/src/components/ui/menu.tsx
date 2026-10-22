"use client";

import { Menu } from "@base-ui/react/menu";
import { tv } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const menuStyles = tv({
  slots: {
    positioner: "z-[110] outline-none",
    popup: "min-w-48 max-w-[calc(100vw-2rem)] origin-[var(--transform-origin)] rounded-lg border border-border bg-raised p-1 text-foreground shadow-overlay outline-none transition-[opacity,transform] duration-fast data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 motion-reduce:transition-none",
    item: "grid min-h-9 cursor-default grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
    indicator: "grid size-4 place-items-center text-primary",
    groupLabel: "px-2.5 py-1.5 text-xs font-semibold text-muted-foreground",
    separator: "my-1 h-px bg-border",
    arrow: "text-raised"
  }
});

const MenuRoot = Menu.Root;
const MenuTrigger = Menu.Trigger;
const MenuPortal = Menu.Portal;
const MenuGroup = Menu.Group;
const MenuRadioGroup = Menu.RadioGroup;
const MenuSubmenuRoot = Menu.SubmenuRoot;

function MenuPositioner({ className, sideOffset = 6, ...props }: Menu.Positioner.Props) { const s = menuStyles(); return <Menu.Positioner data-slot="menu-positioner" sideOffset={sideOffset} className={resolveComponentClassName(className, (v) => s.positioner({ className: v }))} {...props} />; }
function MenuPopup({ className, ...props }: Menu.Popup.Props) { const s = menuStyles(); return <Menu.Popup data-slot="menu-popup" className={resolveComponentClassName(className, (v) => s.popup({ className: v }))} {...props} />; }
function MenuItem({ className, ...props }: Menu.Item.Props) { const s = menuStyles(); return <Menu.Item data-slot="menu-item" className={resolveComponentClassName(className, (v) => s.item({ className: v }))} {...props} />; }
function MenuLinkItem({ className, ...props }: Menu.LinkItem.Props) { const s = menuStyles(); return <Menu.LinkItem data-slot="menu-link-item" className={resolveComponentClassName(className, (v) => s.item({ className: v }))} {...props} />; }
function MenuCheckboxItem({ className, ...props }: Menu.CheckboxItem.Props) { const s = menuStyles(); return <Menu.CheckboxItem data-slot="menu-checkbox-item" className={resolveComponentClassName(className, (v) => s.item({ className: v }))} {...props} />; }
function MenuRadioItem({ className, ...props }: Menu.RadioItem.Props) { const s = menuStyles(); return <Menu.RadioItem data-slot="menu-radio-item" className={resolveComponentClassName(className, (v) => s.item({ className: v }))} {...props} />; }
function MenuSubmenuTrigger({ className, ...props }: Menu.SubmenuTrigger.Props) { const s = menuStyles(); return <Menu.SubmenuTrigger data-slot="menu-submenu-trigger" className={resolveComponentClassName(className, (v) => s.item({ className: v }))} {...props} />; }
function MenuCheckboxItemIndicator({ className, ...props }: Menu.CheckboxItemIndicator.Props) { const s = menuStyles(); return <Menu.CheckboxItemIndicator data-slot="menu-checkbox-indicator" className={resolveComponentClassName(className, (v) => s.indicator({ className: v }))} {...props} />; }
function MenuRadioItemIndicator({ className, ...props }: Menu.RadioItemIndicator.Props) { const s = menuStyles(); return <Menu.RadioItemIndicator data-slot="menu-radio-indicator" className={resolveComponentClassName(className, (v) => s.indicator({ className: v }))} {...props} />; }
function MenuGroupLabel({ className, ...props }: Menu.GroupLabel.Props) { const s = menuStyles(); return <Menu.GroupLabel data-slot="menu-group-label" className={resolveComponentClassName(className, (v) => s.groupLabel({ className: v }))} {...props} />; }
function MenuSeparator({ className, ...props }: Menu.Separator.Props) { const s = menuStyles(); return <Menu.Separator data-slot="menu-separator" className={resolveComponentClassName(className, (v) => s.separator({ className: v }))} {...props} />; }
function MenuArrow({ className, ...props }: Menu.Arrow.Props) { const s = menuStyles(); return <Menu.Arrow data-slot="menu-arrow" className={resolveComponentClassName(className, (v) => s.arrow({ className: v }))} {...props} />; }

export { MenuArrow, MenuCheckboxItem, MenuCheckboxItemIndicator, MenuGroup, MenuGroupLabel, MenuItem, MenuLinkItem, MenuPopup, MenuPortal, MenuPositioner, MenuRadioGroup, MenuRadioItem, MenuRadioItemIndicator, MenuRoot, MenuSeparator, MenuSubmenuRoot, MenuSubmenuTrigger, MenuTrigger, menuStyles };
