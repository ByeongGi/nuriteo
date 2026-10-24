"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { tv } from "tailwind-variants";

const adminNavigationStyles = tv({
  slots: {
    root: "mt-3 block min-w-0 flex-1 overflow-y-auto overflow-x-hidden border-0 px-1 pb-3 [scrollbar-gutter:stable]",
    section: "grid gap-0.5 border-0 p-0 [&+&]:mt-4",
    sectionLabel: "mb-1 px-2 text-[0.625rem] font-semibold tracking-[0.06em] text-subtle-foreground",
    destinations: "grid gap-0.5",
    link: "group relative grid min-h-9 min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 rounded-md px-2 text-xs font-medium text-muted-foreground no-underline outline-none transition-colors before:absolute before:left-0 before:h-4 before:w-0.5 before:rounded-full before:bg-transparent hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar aria-[current=page]:bg-active aria-[current=page]:font-semibold aria-[current=page]:text-foreground aria-[current=page]:before:bg-primary",
    icon: "grid size-4 shrink-0 place-items-center text-subtle-foreground transition-colors group-hover:text-muted-foreground group-aria-[current=page]:text-primary [&_svg]:size-4",
    linkLabel: "min-w-0 truncate"
  },
  variants: {
    placement: {
      mobile: {
        root: "flex-none overflow-visible",
        section: "gap-1 [&+&]:mt-5",
        sectionLabel: "block px-3",
        link: "min-h-11 px-3 text-sm"
      },
      sidebar: {}
    }
  },
  defaultVariants: {
    placement: "sidebar"
  }
});

type AdminNavigationIcon =
  | "audit"
  | "backup"
  | "email"
  | "git"
  | "invitation"
  | "maintenance"
  | "mfa"
  | "oidc"
  | "operations"
  | "recovery"
  | "registry"
  | "settings"
  | "smtp"
  | "updates";

interface AdminNavigationDestination {
  readonly href: string;
  readonly icon: AdminNavigationIcon;
  readonly label: string;
}

const ADMIN_NAV_ICON_PATHS: Record<AdminNavigationIcon, ReactNode> = {
  invitation: <><path d="M2.5 4.5h11v7h-6l-3 2v-2h-2z" /><path d="M5 7h6M8 5v4" /></>,
  recovery: <><circle cx="5.5" cy="8" r="2.5" /><path d="M8 8h5.5M11.5 8v2M13.5 8v1" /></>,
  mfa: <><path d="M8 1.75 3 3.8v3.7c0 3.15 1.95 5.35 5 6.75 3.05-1.4 5-3.6 5-6.75V3.8Z" /><path d="m5.75 8 1.4 1.4L10.5 6" /></>,
  oidc: <><circle cx="5" cy="8" r="2.25" /><circle cx="11" cy="8" r="2.25" /><path d="M7.25 8h1.5M13.25 8h1.25" /></>,
  git: <><circle cx="4" cy="4" r="1.5" /><circle cx="4" cy="12" r="1.5" /><circle cx="12" cy="4" r="1.5" /><path d="M5.5 4h5M4 5.5v5M10.5 4c0 5-6.5 2.5-6.5 6.5" /></>,
  registry: <><path d="m8 1.75 5.5 3.1v6.3L8 14.25l-5.5-3.1v-6.3z" /><path d="m2.8 4.7 5.2 3 5.2-3M8 7.7v6.1" /></>,
  smtp: <><rect x="2" y="3" width="12" height="10" rx="2" /><path d="m3 5 5 3.5L13 5M11 11.5l1.25 1.25L15 10" /></>,
  operations: <><path d="M2 8h2.25l1.4-3.5L8.2 12l1.65-4h4.15" /></>,
  email: <><rect x="2" y="3" width="12" height="10" rx="2" /><path d="m3 5 5 3.5L13 5" /></>,
  maintenance: <><path d="M9.5 3a3.2 3.2 0 0 0 3.75 4.5L8 12.75a2 2 0 1 1-2.75-2.75l5.25-5.25A3.2 3.2 0 0 0 9.5 3Z" /></>,
  backup: <><path d="M3 5.5h10v8H3zM4.5 2.5h7v3h-7z" /><path d="M6 9h4M8 7v4" /></>,
  audit: <><path d="M4 2.5h8v11H4zM6.5 5.5h3M6.5 8h3M6.5 10.5h2" /></>,
  updates: <><path d="M13 5V2.5l-2 2A5 5 0 1 0 12.5 11" /></>,
  settings: <><circle cx="8" cy="8" r="2" /><path d="M8 2.5v1.25M8 12.25v1.25M13.5 8h-1.25M3.75 8H2.5M11.9 4.1l-.9.9M5 11l-.9.9M11.9 11.9 11 11M5 5l-.9-.9" /></>
};

const sections: readonly {
  readonly label: string;
  readonly id: string;
  readonly destinations: readonly AdminNavigationDestination[];
}[] = [
  {
    id: "operations",
    label: "운영",
    destinations: [
      { href: "/admin/operations", icon: "operations", label: "운영 현황" },
      { href: "/admin/operations/email-deliveries", icon: "email", label: "이메일 전송" },
      { href: "/admin/operations/maintenance", icon: "maintenance", label: "점검 모드" },
      { href: "/admin/operations/backups", icon: "backup", label: "백업과 복구" }
    ]
  },
  {
    id: "access",
    label: "접근 관리",
    destinations: [
      { href: "/admin/access/invitations", icon: "invitation", label: "사용자 초대" },
      { href: "/admin/access/mfa-reset", icon: "recovery", label: "접근 복구" },
      { href: "/admin/authentication/mfa", icon: "mfa", label: "MFA 정책" },
      { href: "/admin/authentication/oidc", icon: "oidc", label: "로그인 제공자" }
    ]
  },
  {
    id: "integrations",
    label: "연동",
    destinations: [
      { href: "/admin/integrations/git", icon: "git", label: "Git 제공자" },
      { href: "/admin/integrations/registries", icon: "registry", label: "패키지 저장소" },
      { href: "/admin/integrations/smtp/trust", icon: "smtp", label: "SMTP 인증서" }
    ]
  },
  {
    id: "system",
    label: "시스템",
    destinations: [
      { href: "/admin/system/audit-log", icon: "audit", label: "감사 로그" },
      { href: "/admin/system/updates", icon: "updates", label: "버전 관리" },
      { href: "/admin/system/settings", icon: "settings", label: "인스턴스 설정" }
    ]
  }
];

export function AdminNavigation({
  pathnameOverride,
  placement = "sidebar"
}: Readonly<{
  pathnameOverride?: string | undefined;
  placement?: "mobile" | "sidebar";
}> = {}) {
  const currentPathname = usePathname();
  const pathname = pathnameOverride ?? currentPathname;
  const styles = adminNavigationStyles({ placement });
  const activeDestination = sections
    .flatMap((section) => section.destinations)
    .filter((destination) => pathname === destination.href || pathname.startsWith(`${destination.href}/`))
    .sort((left, right) => right.href.length - left.href.length)[0]?.href;

  return (
    <nav className={styles.root()} aria-label="시스템 관리">
      {sections.map((section) => (
        <section className={styles.section()} key={section.id} aria-labelledby={`admin-nav-${section.id}`}>
          <h2 className={styles.sectionLabel()} id={`admin-nav-${section.id}`}>{section.label}</h2>
          <div className={styles.destinations()}>
            {section.destinations.map((destination) => (
              <Link
                className={styles.link()}
                key={destination.href}
                href={destination.href}
                aria-current={activeDestination === destination.href ? "page" : undefined}
                title={destination.label}
              >
                <span className={styles.icon()}><AdminNavIcon name={destination.icon} /></span>
                <span className={styles.linkLabel()}>{destination.label}</span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </nav>
  );
}
function AdminNavIcon({ name }: Readonly<{ name: AdminNavigationIcon }>) {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      {ADMIN_NAV_ICON_PATHS[name]}
    </svg>
  );
}
