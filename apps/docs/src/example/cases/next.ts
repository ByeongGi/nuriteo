import type { ContainerCase } from "./types.ts";

const packageJson = `{
  "name": "next-app",
  "private": true,
  "scripts": {
    "dev": "next dev"
  }
}
`;

const layoutTsx = `export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
`;

const pageTsx = `export default function Page() {
  return <h1>next-ready</h1>;
}
`;

export const containerCase = {
  kind: "next",
  entry: "app/page.tsx",
  previewScript: "pnpm dev",
  files: [
    { path: "package.json", contents: packageJson },
    { path: "app/layout.tsx", contents: layoutTsx },
    { path: "app/page.tsx", contents: pageTsx }
  ]
} satisfies ContainerCase;
