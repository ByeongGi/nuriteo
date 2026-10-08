"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const destinations = [
  { href: "/admin/operations", label: "Operations" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/invitations", label: "Activation invitations" },
  { href: "/admin/mfa", label: "MFA policy" },
  { href: "/admin/oidc", label: "Identity providers" },
  { href: "/admin/notifications", label: "Email delivery" }
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
