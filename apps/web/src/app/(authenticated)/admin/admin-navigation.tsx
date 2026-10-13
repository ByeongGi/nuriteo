"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const destinations = [
  { href: "/admin/operations", label: "Operations" },
  { href: "/admin/maintenance", label: "Maintenance" },
  { href: "/admin/backups", label: "Backups" },
  { href: "/admin/updates", label: "Updates" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/invitations", label: "Activation invitations" },
  { href: "/admin/mfa", label: "MFA policy" },
  { href: "/admin/oidc", label: "Identity providers" },
  { href: "/admin/registries", label: "Package registries" },
  { href: "/admin/git-providers", label: "Git providers" },
  { href: "/admin/notifications", label: "Email delivery" },
  { href: "/admin/smtp-trust", label: "SMTP trust" },
] as const;

export function AdminNavigation() {
  const pathname = usePathname();
  return (
    <nav className="admin-navigation" aria-label="Administration">
      {destinations.map((destination) => (
        <Link
          key={destination.href}
          href={destination.href}
          aria-current={pathname === destination.href ? "page" : undefined}
        >
          {destination.label}
        </Link>
      ))}
    </nav>
  );
}
