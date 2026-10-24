import type { ReactNode } from "react";

import { PageHeader } from "#src/components/ui/page-header.tsx";

interface AdminPageHeaderProps {
  readonly aside?: ReactNode;
  readonly category: string;
  readonly children?: ReactNode;
  readonly description: ReactNode;
  readonly title: string;
}

export function AdminPageHeader({
  aside,
  category,
  children,
  description,
  title
}: AdminPageHeaderProps) {
  return (
    <div data-slot="admin-page-header" className="grid gap-3">
      <PageHeader
        actions={aside}
        density="compact"
        description={description}
        eyebrow={category}
        title={title}
      />
      {children ? <div data-slot="admin-page-header-content">{children}</div> : null}
    </div>
  );
}
