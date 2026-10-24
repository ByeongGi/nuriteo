import { cookies } from "next/headers";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { Providers } from "#src/app/providers.tsx";
import { SiteHeader } from "#src/components/site-header.tsx";
import { parseThemeMode, THEME_COOKIE_NAME } from "#src/lib/theme.ts";
import "#src/styles/globals.css";

export const metadata: Metadata = {
  description: "설치 없이 브라우저에서 Node.js 프로젝트를 개발하고 실행하는 자체 호스팅 워크스페이스.",
  title: {
    default: "NURITEO",
    template: "%s · NURITEO"
  }
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { color: "#f7f8fa", media: "(prefers-color-scheme: light)" },
    { color: "#0e0f12", media: "(prefers-color-scheme: dark)" }
  ]
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const cookieStore = await cookies();
  const themeMode = parseThemeMode(cookieStore.get(THEME_COOKIE_NAME)?.value);

  return (
    <html lang="ko" data-theme-mode={themeMode}>
      <body>
        <Providers>
          <a className="fixed top-2 left-2 z-[var(--n-z-toast)] -translate-y-[150%] rounded-md bg-raised px-3 py-2 text-foreground shadow-[var(--n-shadow-overlay)] focus:translate-y-0" href="#main-content">
            본문으로 건너뛰기
          </a>
          <div className="isolate min-h-screen">
            <SiteHeader themeMode={themeMode} />
            {children}
          </div>
        </Providers>
      </body>
    </html>
  );
}
