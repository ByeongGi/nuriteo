import type { ComponentProps } from "react";

import { cn } from "@/lib/utils.ts";

function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div className="relative mb-6 w-full overflow-auto rounded-lg border">
      <table className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}

function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={cn("bg-subtle [&_tr]:border-b", className)} {...props} />;
}

function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return <tr className={cn("border-b border-border", className)} {...props} />;
}

function TableHead({ className, ...props }: ComponentProps<"th">) {
  return <th className={cn("h-10 px-3 text-left align-middle font-medium text-muted-foreground", className)} {...props} />;
}

function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("px-3 py-2.5 align-top", className)} {...props} />;
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };
