"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const sections = [
  {
    label: "운영",
    destinations: [
      { href: "/admin/operations", label: "운영 현황" },
      { href: "/admin/updates", label: "업데이트" }
    ]
  },
  {
    label: "사용자 및 접근",
    destinations: [
      { href: "/admin/invitations", label: "가입 초대" },
      { href: "/admin/mfa", label: "MFA 정책" },
      { href: "/admin/oidc", label: "인증 제공자" }
    ]
  },
  {
    label: "연동",
    destinations: [
      { href: "/admin/registries", label: "패키지 저장소" },
      { href: "/admin/git-providers", label: "Git 제공자" },
      { href: "/admin/notifications", label: "이메일 전송" },
      { href: "/admin/smtp-trust", label: "SMTP 인증서" }
    ]
  },
  {
    label: "시스템",
    destinations: [
      { href: "/admin/maintenance", label: "유지보수" },
      { href: "/admin/backups", label: "백업" },
      { href: "/admin/settings", label: "인스턴스 설정" }
    ]
  }
] as const;

export function AdminNavigation({ pathnameOverride }: Readonly<{ pathnameOverride?: string | undefined }> = {}) {
  const currentPathname = usePathname();
  const pathname = pathnameOverride ?? currentPathname;
  return (
    <nav className="admin-navigation" aria-label="시스템 관리">
      <Link
        className="admin-navigation__home"
        href="/admin"
        aria-current={pathname === "/admin" ? "page" : undefined}
      >
        관리자 홈
      </Link>
      {sections.map((section) => (
        <section key={section.label} aria-labelledby={`admin-nav-${section.label}`}>
          <h2 id={`admin-nav-${section.label}`}>{section.label}</h2>
          <div>
            {section.destinations.map((destination) => (
              <Link
                key={destination.href}
                href={destination.href}
                aria-current={pathname === destination.href ? "page" : undefined}
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
