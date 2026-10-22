"use client";

import { ContextMenu } from "@base-ui/react/context-menu";

import {
  MenuArrow as ContextMenuArrow,
  MenuCheckboxItem as ContextMenuCheckboxItem,
  MenuCheckboxItemIndicator as ContextMenuCheckboxItemIndicator,
  MenuGroup as ContextMenuGroup,
  MenuGroupLabel as ContextMenuGroupLabel,
  MenuItem as ContextMenuItem,
  MenuLinkItem as ContextMenuLinkItem,
  MenuPopup as ContextMenuPopup,
  MenuRadioGroup as ContextMenuRadioGroup,
  MenuRadioItem as ContextMenuRadioItem,
  MenuRadioItemIndicator as ContextMenuRadioItemIndicator,
  MenuSeparator as ContextMenuSeparator,
  MenuSubmenuRoot as ContextMenuSubmenuRoot,
  MenuSubmenuTrigger as ContextMenuSubmenuTrigger
} from "#src/components/ui/menu.tsx";

const ContextMenuRoot = ContextMenu.Root;
const ContextMenuTrigger = ContextMenu.Trigger;
const ContextMenuPortal = ContextMenu.Portal;
const ContextMenuPositioner = ContextMenu.Positioner;

export {
  ContextMenuArrow,
  ContextMenuCheckboxItem,
  ContextMenuCheckboxItemIndicator,
  ContextMenuGroup,
  ContextMenuGroupLabel,
  ContextMenuItem,
  ContextMenuLinkItem,
  ContextMenuPopup,
  ContextMenuPortal,
  ContextMenuPositioner,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuRadioItemIndicator,
  ContextMenuRoot,
  ContextMenuSeparator,
  ContextMenuSubmenuRoot,
  ContextMenuSubmenuTrigger,
  ContextMenuTrigger
};
