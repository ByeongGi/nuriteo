import Link from "next/link";
import type { ReactNode } from "react";

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
    <header className="workspace-page__intro admin-page-header">
      <div className="admin-page-header__copy">
        <nav aria-label="현재 위치">
          <Link href="/admin">관리자 홈</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{category}</span>
        </nav>
        <h1>{title}</h1>
        <p>{description}</p>
        {children}
      </div>
      {aside ? <div className="admin-page-header__aside">{aside}</div> : null}
    </header>
  );
}
