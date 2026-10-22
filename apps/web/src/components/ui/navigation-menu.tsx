"use client";

import { NavigationMenu } from "@base-ui/react/navigation-menu";
import { tv } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const navigationMenuStyles = tv({
  slots: {
    root: "relative min-w-0",
    list: "flex min-w-0 items-center gap-1",
    item: "relative",
    trigger: "group inline-flex min-h-9 items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus data-[popup-open]:bg-active data-[popup-open]:text-foreground motion-reduce:transition-none",
    icon: "text-xs transition-transform duration-fast group-data-[popup-open]:rotate-180 motion-reduce:transition-none",
    link: "block rounded-md px-3 py-2 text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus data-[active]:bg-selected data-[active]:text-foreground motion-reduce:transition-none",
    positioner: "z-[110] outline-none",
    popup: "origin-[var(--transform-origin)] rounded-lg border border-border bg-raised p-2 text-foreground shadow-overlay outline-none transition-[opacity,transform] duration-fast data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 motion-reduce:transition-none",
    content: "w-[min(32rem,calc(100vw-2rem))] p-2",
    viewport: "relative overflow-hidden",
    arrow: "text-raised"
  }
});

function NavigationMenuRoot({ className, ...props }: NavigationMenu.Root.Props) { const s = navigationMenuStyles(); return <NavigationMenu.Root data-slot="navigation-menu" className={resolveComponentClassName(className, (v) => s.root({ className: v }))} {...props} />; }
function NavigationMenuList({ className, ...props }: NavigationMenu.List.Props) { const s = navigationMenuStyles(); return <NavigationMenu.List data-slot="navigation-menu-list" className={resolveComponentClassName(className, (v) => s.list({ className: v }))} {...props} />; }
function NavigationMenuItem({ className, ...props }: NavigationMenu.Item.Props) { const s = navigationMenuStyles(); return <NavigationMenu.Item data-slot="navigation-menu-item" className={resolveComponentClassName(className, (v) => s.item({ className: v }))} {...props} />; }
function NavigationMenuTrigger({ className, ...props }: NavigationMenu.Trigger.Props) { const s = navigationMenuStyles(); return <NavigationMenu.Trigger data-slot="navigation-menu-trigger" className={resolveComponentClassName(className, (v) => s.trigger({ className: v }))} {...props} />; }
function NavigationMenuIcon({ className, ...props }: NavigationMenu.Icon.Props) { const s = navigationMenuStyles(); return <NavigationMenu.Icon data-slot="navigation-menu-icon" className={resolveComponentClassName(className, (v) => s.icon({ className: v }))} {...props} />; }
function NavigationMenuLink({ className, ...props }: NavigationMenu.Link.Props) { const s = navigationMenuStyles(); return <NavigationMenu.Link data-slot="navigation-menu-link" className={resolveComponentClassName(className, (v) => s.link({ className: v }))} {...props} />; }
function NavigationMenuPositioner({ className, ...props }: NavigationMenu.Positioner.Props) { const s = navigationMenuStyles(); return <NavigationMenu.Positioner data-slot="navigation-menu-positioner" className={resolveComponentClassName(className, (v) => s.positioner({ className: v }))} {...props} />; }
function NavigationMenuPopup({ className, ...props }: NavigationMenu.Popup.Props) { const s = navigationMenuStyles(); return <NavigationMenu.Popup data-slot="navigation-menu-popup" className={resolveComponentClassName(className, (v) => s.popup({ className: v }))} {...props} />; }
function NavigationMenuContent({ className, ...props }: NavigationMenu.Content.Props) { const s = navigationMenuStyles(); return <NavigationMenu.Content data-slot="navigation-menu-content" className={resolveComponentClassName(className, (v) => s.content({ className: v }))} {...props} />; }
function NavigationMenuViewport({ className, ...props }: NavigationMenu.Viewport.Props) { const s = navigationMenuStyles(); return <NavigationMenu.Viewport data-slot="navigation-menu-viewport" className={resolveComponentClassName(className, (v) => s.viewport({ className: v }))} {...props} />; }
function NavigationMenuArrow({ className, ...props }: NavigationMenu.Arrow.Props) { const s = navigationMenuStyles(); return <NavigationMenu.Arrow data-slot="navigation-menu-arrow" className={resolveComponentClassName(className, (v) => s.arrow({ className: v }))} {...props} />; }

const NavigationMenuPortal = NavigationMenu.Portal;

export { NavigationMenuArrow, NavigationMenuContent, NavigationMenuIcon, NavigationMenuItem, NavigationMenuLink, NavigationMenuList, NavigationMenuPopup, NavigationMenuPortal, NavigationMenuPositioner, NavigationMenuRoot, NavigationMenuTrigger, NavigationMenuViewport, navigationMenuStyles };
