"use client";

import { Avatar } from "@base-ui/react/avatar";
import { tv } from "tailwind-variants";
import type { VariantProps } from "tailwind-variants";

import { resolveComponentClassName } from "#src/components/ui/component-class-name.ts";

const avatarStyles = tv({
  slots: {
    root: "relative inline-flex shrink-0 overflow-hidden rounded-full bg-subtle align-middle",
    image: "size-full object-cover",
    fallback: "grid size-full place-items-center font-semibold text-muted-foreground"
  },
  variants: {
    size: {
      sm: { root: "size-7", fallback: "text-[0.625rem]" },
      md: { root: "size-9", fallback: "text-xs" },
      lg: { root: "size-12", fallback: "text-sm" }
    }
  },
  defaultVariants: { size: "md" }
});

type AvatarRootProps = Avatar.Root.Props & VariantProps<typeof avatarStyles>;

function AvatarRoot({ className, size, ...props }: AvatarRootProps) {
  const styles = avatarStyles({ size });
  return <Avatar.Root data-slot="avatar" className={resolveComponentClassName(className, (override) => styles.root({ className: override }))} {...props} />;
}

function AvatarImage({ className, ...props }: Avatar.Image.Props) {
  const styles = avatarStyles();
  return <Avatar.Image data-slot="avatar-image" className={resolveComponentClassName(className, (override) => styles.image({ className: override }))} {...props} />;
}

function AvatarFallback({ className, ...props }: Avatar.Fallback.Props) {
  const styles = avatarStyles();
  return <Avatar.Fallback data-slot="avatar-fallback" className={resolveComponentClassName(className, (override) => styles.fallback({ className: override }))} {...props} />;
}

export { AvatarFallback, AvatarImage, AvatarRoot, avatarStyles };
export type { AvatarRootProps };
