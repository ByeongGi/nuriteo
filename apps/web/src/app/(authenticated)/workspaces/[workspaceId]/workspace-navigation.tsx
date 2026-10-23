"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { tv } from "tailwind-variants";

const navigationStyles = tv({
  slots: {
    root: "mx-auto flex w-full max-w-[100rem] items-center gap-1 overflow-x-auto border-b border-muted-border px-[clamp(1.25rem,4vw,3.5rem)] pt-4 max-[48rem]:px-4",
    link: "inline-flex min-h-11 shrink-0 items-center border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground no-underline hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:text-foreground"
  }
});

interface Props {
  readonly organization: boolean;
  readonly workspaceId: string;
}

export function WorkspaceNavigation({ organization, workspaceId }: Props) {
  const pathname = usePathname();
  const styles = navigationStyles();
  const base = `/workspaces/${encodeURIComponent(workspaceId)}`;
  const items = [
    { href: `${base}/projects`, label: "프로젝트", segment: "/projects" },
    ...(organization ? [
      { href: `${base}/members`, label: "멤버", segment: "/members" },
      { href: `${base}/teams`, label: "팀", segment: "/teams" }
    ] : []),
    { href: `${base}/settings`, label: "워크스페이스 설정", segment: "/settings" }
  ];

  return (
    <nav className={styles.root()} aria-label="워크스페이스 메뉴">
      {items.map((item) => (
        <Link
          className={styles.link()}
          href={item.href}
          aria-current={pathname.startsWith(`${base}${item.segment}`) ? "page" : undefined}
          key={item.href}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
