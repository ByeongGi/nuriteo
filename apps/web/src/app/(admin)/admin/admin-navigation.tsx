"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { tv } from "tailwind-variants";

const adminNavigationStyles = tv({
  slots: {
    root: "mt-5 block min-w-0 flex-1 overflow-auto border-0 p-0",
    home: "mb-5",
    section: "block border-0 p-0 [&+&]:mt-5",
    sectionLabel: "mb-2 px-3 text-[var(--n-font-size-2xs)] font-semibold tracking-[0.04em] text-subtle-foreground",
    destinations: "grid gap-0.5",
    link: "flex min-h-10 items-center rounded-md px-3 text-sm font-medium text-muted-foreground no-underline hover:bg-hover hover:text-foreground aria-[current=page]:bg-[color-mix(in_srgb,var(--n-color-action-primary)_9%,var(--n-color-bg-surface))] aria-[current=page]:text-primary aria-[current=page]:shadow-[inset_3px_0_var(--n-color-action-primary)]"
  },
  variants: {
    placement: {
      mobile: {
        root: "flex-none overflow-visible",
        sectionLabel: "block"
      },
      sidebar: {}
    }
  },
  defaultVariants: {
    placement: "sidebar"
  }
});

const sections: readonly {
  readonly label: string;
  readonly destinations: readonly { readonly href: string; readonly label: string }[];
}[] = [
  {
    label: "사용자·접근",
    destinations: [
      { href: "/admin/access/users", label: "사용자 디렉터리" },
      { href: "/admin/access/sessions", label: "사용자 세션" },
      { href: "/admin/access/invitations", label: "가입 초대" },
      { href: "/admin/access/mfa-reset", label: "사용자 MFA 초기화" }
    ]
  },
  {
    label: "인증",
    destinations: [
      { href: "/admin/authentication/mfa", label: "MFA 정책" },
      { href: "/admin/authentication/oidc", label: "OIDC 제공자" }
    ]
  },
  {
    label: "연동",
    destinations: [
      { href: "/admin/integrations/git", label: "Git 제공자" },
      { href: "/admin/integrations/registries", label: "패키지 저장소" },
      { href: "/admin/integrations/smtp/trust", label: "SMTP 인증서" }
    ]
  },
  {
    label: "운영",
    destinations: [
      { href: "/admin/operations", label: "운영 현황" },
      { href: "/admin/operations/email-deliveries", label: "이메일 전송" },
      { href: "/admin/operations/maintenance", label: "점검 모드" },
      { href: "/admin/operations/backups", label: "백업" }
    ]
  },
  {
    label: "시스템",
    destinations: [
      { href: "/admin/system/audit-log", label: "감사 로그" },
      { href: "/admin/system/updates", label: "업데이트" },
      { href: "/admin/system/settings", label: "인스턴스 설정" }
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
      <Link
        className={styles.link({ className: styles.home() })}
        href="/admin"
        aria-current={pathname === "/admin" ? "page" : undefined}
      >
        관리자 홈
      </Link>
      {sections.map((section) => (
        <section className={styles.section()} key={section.label} aria-labelledby={`admin-nav-${section.label}`}>
          <h2 className={styles.sectionLabel()} id={`admin-nav-${section.label}`}>{section.label}</h2>
          <div className={styles.destinations()}>
            {section.destinations.map((destination) => (
              <Link
                className={styles.link()}
                key={destination.href}
                href={destination.href}
                aria-current={activeDestination === destination.href ? "page" : undefined}
              >
                {destination.label}
              </Link>
            ))}
          </div>
        </section>
      ))}
    </nav>
  );
}

export { adminNavigationStyles };
