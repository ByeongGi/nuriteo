import { cookies } from "next/headers";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { SiteHeader } from "../components/site-header.tsx";
import { parseThemeMode, THEME_COOKIE_NAME } from "../lib/theme.ts";
import "../styles/globals.css";

export const metadata: Metadata = {
  description: "A self-hosted browser development workspace.",
  title: {
    default: "NURITEO",
    template: "%s · NURITEO"
  }
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { color: "#f7f7f4", media: "(prefers-color-scheme: light)" },
    { color: "#11110f", media: "(prefers-color-scheme: dark)" }
  ]
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const cookieStore = await cookies();
  const themeMode = parseThemeMode(cookieStore.get(THEME_COOKIE_NAME)?.value);

  return (
    <html lang="en" data-theme-mode={themeMode}>
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <div className="application-root">
          <SiteHeader themeMode={themeMode} />
          {children}
        </div>
      </body>
    </html>
  );
}
