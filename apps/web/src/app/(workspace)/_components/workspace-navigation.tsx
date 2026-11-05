"use client";

import Link from "next/link";
import { tv } from "tailwind-variants";

import { useWorkspaceNavigation } from "@/app/(workspace)/_hooks/use-workspace-navigation.ts";

const navigationStyles = tv({
  slots: {
    root: "mt-3 block min-w-0 flex-1 overflow-auto",
    section: "grid gap-0.5 [&+&]:mt-4",
    label: "mb-1 px-2.5 text-[0.625rem] font-semibold tracking-[0.05em] text-subtle-foreground",
    link: "group flex min-h-8 items-center gap-2 rounded-md px-2.5 text-xs font-medium text-muted-foreground no-underline hover:bg-hover hover:text-foreground aria-[current=page]:bg-active aria-[current=page]:text-foreground",
    icon: "size-4 shrink-0 text-subtle-foreground group-aria-[current=page]:text-primary",
    badge: "ml-auto grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[0.625rem] text-on-primary"
  },
  variants: {
    placement: {
      mobile: {
        root: "flex-none overflow-visible",
        link: "min-h-10 text-sm"
      },
      sidebar: {}
    }
  },
  defaultVariants: {
    placement: "sidebar"
  }
});

interface Props {
  readonly organization: boolean;
  readonly workspaceId: string;
}

type WorkspaceNavigationIcon = "members" | "projects" | "settings" | "teams";

interface WorkspaceNavigationItem {
  readonly href: string;
  readonly icon: WorkspaceNavigationIcon;
  readonly label: string;
  readonly projectRoot?: boolean;
}

interface WorkspaceNavigationSection {
  readonly items: readonly WorkspaceNavigationItem[];
  readonly label: string;
}

export function WorkspaceNavigation({
  organization,
  placement = "sidebar",
  workspaceId
}: Props & { readonly placement?: "mobile" | "sidebar" }) {
  const styles = navigationStyles({ placement });
  const base = `/workspaces/${encodeURIComponent(workspaceId)}`;
  const { isCurrentDestination } = useWorkspaceNavigation(base);

  const managementItems: readonly WorkspaceNavigationItem[] = [
    ...(organization ? [
      { href: `${base}/members`, icon: "members" as const, label: "멤버" },
      { href: `${base}/teams`, icon: "teams" as const, label: "팀" }
    ] : []),
    { href: `${base}/settings`, icon: "settings", label: "설정" }
  ];
  const sections: readonly WorkspaceNavigationSection[] = [
    {
      label: "작업",
      items: [{ href: base, icon: "projects", label: "프로젝트", projectRoot: true }]
    },
    {
      label: "관리",
      items: managementItems
    }
  ];

  return (
    <nav className={styles.root()} aria-label="워크스페이스 메뉴">
      {sections.map((section) => (
        <section className={styles.section()} key={section.label}>
          <h2 className={styles.label()}>{section.label}</h2>
          {section.items.map((item) => (
            <Link
              className={styles.link()}
              href={item.href}
              aria-current={isCurrentDestination(item) ? "page" : undefined}
              key={item.href}
            >
              <WorkspaceNavIcon className={styles.icon()} name={item.icon} />
              <span>{item.label}</span>
            </Link>
          ))}
        </section>
      ))}
    </nav>
  );
}

function WorkspaceNavIcon({ className, name }: Readonly<{ className: string; name: WorkspaceNavigationIcon }>) {
  if (name === "projects") {
    return <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 16 16"><path d="M2.5 3.5h4l1 1h6v8h-11z" stroke="currentColor" strokeLinejoin="round" /></svg>;
  }
  if (name === "members") {
    return <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 16 16"><circle cx="8" cy="5" r="2.25" stroke="currentColor" /><path d="M3.5 13c.35-2.25 2-3.5 4.5-3.5s4.15 1.25 4.5 3.5" stroke="currentColor" strokeLinecap="round" /></svg>;
  }
  if (name === "teams") {
    return <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 16 16"><circle cx="5.25" cy="5.5" r="1.75" stroke="currentColor" /><circle cx="11.25" cy="6.25" r="1.5" stroke="currentColor" /><path d="M1.75 12.5c.3-2 1.55-3 3.5-3 2 0 3.2 1 3.5 3M9.25 9.75c1.8-.45 3.9.3 4.5 2.25" stroke="currentColor" strokeLinecap="round" /></svg>;
  }
  return <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2" stroke="currentColor" /><path d="M8 2.25v1.5M8 12.25v1.5M13.75 8h-1.5M3.75 8h-1.5M12.07 3.93 11 5M5 11l-1.07 1.07M12.07 12.07 11 11M5 5 3.93 3.93" stroke="currentColor" strokeLinecap="round" /></svg>;
}
