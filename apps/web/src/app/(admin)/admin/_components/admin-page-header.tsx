import Link from "next/link";
import type { ReactNode } from "react";

import { adminPageHeaderStyles } from "#src/app/(admin)/admin/_components/admin-page-header.styles.ts";

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
  const styles = adminPageHeaderStyles();

  return (
    <header data-slot="admin-page-header" className={styles.root()}>
      <div data-slot="admin-page-header-copy" className={styles.copy()}>
        <nav data-slot="admin-page-header-breadcrumb" className={styles.breadcrumb()} aria-label="현재 위치">
          <Link href="/admin">관리자 홈</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{category}</span>
        </nav>
        <h1 className={styles.title()}>{title}</h1>
        <p className={styles.description()}>{description}</p>
        {children ? <div data-slot="admin-page-header-content" className={styles.content()}>{children}</div> : null}
      </div>
      {aside ? <div data-slot="admin-page-header-aside" className={styles.aside()}>{aside}</div> : null}
    </header>
  );
}
