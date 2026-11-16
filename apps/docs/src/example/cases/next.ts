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

const pageTsx = `const greeting = "안녕하세요";
const place = "누리터";

export default function Page() {
  return (
    <main>
      <p>next-ready</p>
      <h1>{greeting}</h1>
      <p>{place}에 온 사람에게 인사를 건넵니다.</p>
    </main>
  );
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
