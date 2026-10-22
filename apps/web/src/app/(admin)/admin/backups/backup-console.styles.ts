import { tv } from "tailwind-variants";

export const backupConsoleStyles = tv({
  slots: {
    formBody: "col-span-full border-t border-muted-border p-5",
    toggle:
      "col-span-full min-w-0",
    retention: "grid min-w-0 gap-2"
  }
});
