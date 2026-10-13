import type { SupportedPackageManager } from "./package-detect.ts";

export type TemplateId = "vite-react" | "vite-ts" | "minimal-npm" | "minimal-pnpm" | "next-app";

export interface TemplateFile {
  path: string;
  data: string;
}

export interface ProjectTemplate {
  id: TemplateId;
  name: string;
  description: string;
  packageManager: SupportedPackageManager;
  framework: string;
  files: TemplateFile[];
}

export function listProjectTemplates(): ProjectTemplate[] {
  return [
    createViteReactTemplate(),
    createNextAppTemplate(),
    createViteTsTemplate(),
    createMinimalTemplate("minimal-npm", "npm"),
    createMinimalTemplate("minimal-pnpm", "pnpm")
  ];
}

export function getProjectTemplate(id: TemplateId): ProjectTemplate {
  const template = listProjectTemplates().find((entry) => entry.id === id);
  if (!template) throw new Error(`Unknown project template: ${id}`);
  return template;
}

/** Maps product gallery templates onto ViteProductWorkflow template kinds. */
export function workflowTemplateForProjectTemplate(id: TemplateId): "react" | "vanilla" | "next" {
  if (id === "vite-react") return "react";
  if (id === "next-app") return "next";
  return "vanilla";
}

function createNextAppTemplate(): ProjectTemplate {
  return {
    id: "next-app",
    name: "Next.js App Router",
    description: "Product-supported App Router preview (multi-route)",
    packageManager: "pnpm",
    framework: "next-app",
    files: [
      {
        path: "package.json",
        data: JSON.stringify({
          name: "next-app",
          private: true,
          version: "0.0.0",
          scripts: {
            dev: "next dev",
            build: "next build",
            start: "next start"
          },
          dependencies: {
            next: "15.5.26",
            react: "^19.0.0",
            "react-dom": "^19.0.0"
          },
          devDependencies: {
            "@types/node": "^22.0.0",
            "@types/react": "^19.0.0",
            "@types/react-dom": "^19.0.0",
            typescript: "^5.7.2"
          }
        }, null, 2) + "\n"
      },
      {
        path: "app/layout.tsx",
        data: [
          "export const metadata = {",
          "  title: \"Next.js\",",
          "  description: \"Next.js App Router preview\",",
          "};",
          "",
          "export default function RootLayout({",
          "  children,",
          "}: Readonly<{ children: React.ReactNode }>) {",
          "  return (",
          "    <html lang=\"en\">",
          "      <body>{children}</body>",
          "    </html>",
          "  );",
          "}",
          ""
        ].join("\n")
      },
      {
        path: "app/page.tsx",
        data: [
          "import Link from \"next/link\";",
          "",
          "export default function Page() {",
          "  return (",
          "    <main>",
          "      <h1>Next.js</h1>",
          "      <p>Edit <code>app/page.tsx</code> to get started.</p>",
          "      <p><Link href=\"/about\">About</Link></p>",
          "    </main>",
          "  );",
          "}",
          ""
        ].join("\n")
      },
      {
        path: "app/about/page.tsx",
        data: [
          "import Link from \"next/link\";",
          "",
          "export default function AboutPage() {",
          "  return (",
          "    <main>",
          "      <h1>About</h1>",
          "      <p>Multi-route App Router preview.</p>",
          "      <p><Link href=\"/\">Home</Link></p>",
          "    </main>",
          "  );",
          "}",
          ""
        ].join("\n")
      },
      {
        path: "app/globals.css",
        data: [
          ":root {",
          "  font-family: system-ui, sans-serif;",
          "}",
          "",
          "body {",
          "  margin: 0;",
          "}",
          "",
          "main {",
          "  padding: 2rem;",
          "}",
          ""
        ].join("\n")
      },
      {
        path: "next.config.ts",
        data: [
          "import type { NextConfig } from \"next\";",
          "",
          "const nextConfig: NextConfig = {};",
          "",
          "export default nextConfig;",
          ""
        ].join("\n")
      },
      {
        path: "next-env.d.ts",
        data: "/// <reference types=\"next\" />\n/// <reference types=\"next/image-types/global\" />\n"
      },
      {
        path: "tsconfig.json",
        data: JSON.stringify({
          compilerOptions: {
            target: "ES2017",
            lib: ["dom", "dom.iterable", "esnext"],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: "esnext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: "preserve",
            incremental: true,
            plugins: [{ name: "next" }],
            paths: { "@/*": ["./*"] }
          },
          include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
          exclude: ["node_modules"]
        }, null, 2) + "\n"
      },
      {
        path: "pnpm-lock.yaml",
        data: [
          "lockfileVersion: '9.0'",
          "importers:",
          "  .:",
          "    dependencies:",
          "      next: product-fixture",
          "      react: product-fixture",
          "      react-dom: product-fixture",
          ""
        ].join("\n")
      }
    ]
  };
}

function createViteReactTemplate(): ProjectTemplate {
  // Mirrors the common `npm create vite@latest -- --template react-ts` shape.
  return {
    id: "vite-react",
    name: "Vite + React + TS",
    description: "Standard Vite React TypeScript (TSX) starter",
    packageManager: "pnpm",
    framework: "vite-react-ts",
    files: [
      {
        path: "package.json",
        data: JSON.stringify({
          name: "vite-react-ts",
          private: true,
          version: "0.0.0",
          type: "module",
          packageManager: "pnpm@9.15.9",
          scripts: {
            dev: "vite --host 127.0.0.1",
            // Product adapter currently accepts the exact `vite build` script.
            build: "vite build",
            preview: "vite preview --host 127.0.0.1"
          },
          dependencies: {
            react: "^19.0.0",
            "react-dom": "^19.0.0"
          },
          devDependencies: {
            "@types/react": "^19.0.0",
            "@types/react-dom": "^19.0.0",
            "@vitejs/plugin-react": "^4.3.4",
            typescript: "~5.7.2",
            vite: "^6.2.0"
          }
        }, null, 2) + "\n"
      },
      {
        path: "index.html",
        data: [
          "<!doctype html>",
          "<html lang=\"en\">",
          "  <head>",
          "    <meta charset=\"UTF-8\" />",
          "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />",
          "    <title>Vite + React + TS</title>",
          "  </head>",
          "  <body>",
          "    <div id=\"root\"></div>",
          "    <script type=\"module\" src=\"/src/main.tsx\"></script>",
          "  </body>",
          "</html>",
          ""
        ].join("\n")
      },
      {
        path: "vite.config.ts",
        data: [
          "import { defineConfig } from \"vite\";",
          "import react from \"@vitejs/plugin-react\";",
          "",
          "// https://vite.dev/config/",
          "export default defineConfig({",
          "  plugins: [react()],",
          "});",
          ""
        ].join("\n")
      },
      {
        path: "tsconfig.json",
        data: JSON.stringify({
          files: [],
          references: [
            { path: "./tsconfig.app.json" },
            { path: "./tsconfig.node.json" }
          ]
        }, null, 2) + "\n"
      },
      {
        path: "tsconfig.app.json",
        data: JSON.stringify({
          compilerOptions: {
            tsBuildInfoFile: "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
            target: "ES2020",
            useDefineForClassFields: true,
            lib: ["ES2020", "DOM", "DOM.Iterable"],
            module: "ESNext",
            skipLibCheck: true,
            moduleResolution: "bundler",
            allowImportingTsExtensions: true,
            isolatedModules: true,
            moduleDetection: "force",
            noEmit: true,
            jsx: "react-jsx",
            strict: true,
            noUnusedLocals: true,
            noUnusedParameters: true,
            noFallthroughCasesInSwitch: true,
            noUncheckedSideEffectImports: true
          },
          include: ["src"]
        }, null, 2) + "\n"
      },
      {
        path: "tsconfig.node.json",
        data: JSON.stringify({
          compilerOptions: {
            tsBuildInfoFile: "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
            target: "ES2022",
            lib: ["ES2023"],
            module: "ESNext",
            skipLibCheck: true,
            moduleResolution: "bundler",
            allowImportingTsExtensions: true,
            isolatedModules: true,
            moduleDetection: "force",
            noEmit: true,
            strict: true,
            noUnusedLocals: true,
            noUnusedParameters: true,
            noFallthroughCasesInSwitch: true,
            noUncheckedSideEffectImports: true
          },
          include: ["vite.config.ts"]
        }, null, 2) + "\n"
      },
      {
        path: "src/vite-env.d.ts",
        data: "/// <reference types=\"vite/client\" />\n"
      },
      {
        path: "src/main.tsx",
        data: [
          "import { StrictMode } from \"react\";",
          "import { createRoot } from \"react-dom/client\";",
          "import \"./index.css\";",
          "import App from \"./App.tsx\";",
          "",
          "createRoot(document.getElementById(\"root\")!).render(",
          "  <StrictMode>",
          "    <App />",
          "  </StrictMode>",
          ");",
          ""
        ].join("\n")
      },
      {
        path: "src/App.tsx",
        data: [
          "import { useState } from \"react\";",
          "import { label } from \"./message\";",
          "import \"./App.css\";",
          "",
          "function App() {",
          "  const [count, setCount] = useState(1);",
          "",
          "  return (",
          "    <div id=\"app\">",
          "      <h1>Vite + React + TS</h1>",
          "      <div className=\"card\">",
          "        <button type=\"button\" onClick={() => setCount((value) => value + 1)}>",
          "          {label}:{count}",
          "        </button>",
          "        <p>",
          "          Edit <code>src/App.tsx</code> and save to test HMR",
          "        </p>",
          "      </div>",
          "    </div>",
          "  );",
          "}",
          "",
          "export default App;",
          ""
        ].join("\n")
      },
      {
        path: "src/message.ts",
        data: "export const label = \"nuriteo\";\n"
      },
      {
        path: "src/debug.ts",
        data: [
          "let counter = 0;",
          "counter += 1;",
          "counter += 1;",
          "counter += 1;",
          "console.log(counter);",
          ""
        ].join("\n")
      },
      {
        path: "src/App.css",
        data: [
          "#app {",
          "  max-width: 48rem;",
          "  margin: 0 auto;",
          "  padding: 2rem;",
          "  text-align: center;",
          "  font-family: system-ui, sans-serif;",
          "}",
          "",
          ".card {",
          "  padding: 1.5rem;",
          "}",
          "",
          "button {",
          "  border-radius: 8px;",
          "  border: 1px solid transparent;",
          "  padding: 0.6em 1.2em;",
          "  font-size: 1em;",
          "  font-weight: 500;",
          "  font-family: inherit;",
          "  background-color: #1a1a1a;",
          "  color: #fff;",
          "  cursor: pointer;",
          "}",
          "",
          "button:hover {",
          "  border-color: #646cff;",
          "}",
          ""
        ].join("\n")
      },
      {
        path: "src/index.css",
        data: [
          ":root {",
          "  font-family: system-ui, Avenir, Helvetica, Arial, sans-serif;",
          "  line-height: 1.5;",
          "  font-weight: 400;",
          "  color: #213547;",
          "  background-color: #ffffff;",
          "  font-synthesis: none;",
          "  text-rendering: optimizeLegibility;",
          "  -webkit-font-smoothing: antialiased;",
          "  -moz-osx-font-smoothing: grayscale;",
          "}",
          "",
          "body {",
          "  margin: 0;",
          "  min-width: 320px;",
          "  min-height: 100vh;",
          "}",
          "",
          "h1 {",
          "  font-size: 2.2em;",
          "  line-height: 1.1;",
          "}",
          ""
        ].join("\n")
      },
      {
        path: "pnpm-lock.yaml",
        data: [
          "lockfileVersion: '9.0'",
          "importers:",
          "  .:",
          "    dependencies:",
          "      react: product-fixture",
          "      react-dom: product-fixture",
          "    devDependencies:",
          "      '@types/react': product-fixture",
          "      '@types/react-dom': product-fixture",
          "      '@vitejs/plugin-react': product-fixture",
          "      typescript: product-fixture",
          "      vite: product-fixture",
          ""
        ].join("\n")
      }
    ]
  };
}

function createViteTsTemplate(): ProjectTemplate {
  return {
    id: "vite-ts",
    name: "Vite + TypeScript",
    description: "Vanilla Vite TypeScript starter",
    packageManager: "npm",
    framework: "vite-ts",
    files: [
      {
        path: "package.json",
        data: JSON.stringify({
          name: "vite-ts",
          private: true,
          version: "0.0.0",
          type: "module",
          scripts: {
            dev: "vite --host 127.0.0.1",
            build: "vite build",
            preview: "vite preview --host 127.0.0.1"
          },
          devDependencies: {
            typescript: "~5.7.2",
            vite: "^6.2.0"
          }
        }, null, 2) + "\n"
      },
      {
        path: "index.html",
        data: [
          "<!doctype html>",
          "<html lang=\"en\">",
          "  <head>",
          "    <meta charset=\"UTF-8\" />",
          "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />",
          "    <title>Vite + TS</title>",
          "  </head>",
          "  <body>",
          "    <div id=\"app\"></div>",
          "    <script type=\"module\" src=\"/src/main.ts\"></script>",
          "  </body>",
          "</html>",
          ""
        ].join("\n")
      },
      {
        path: "tsconfig.json",
        data: JSON.stringify({
          compilerOptions: {
            target: "ES2020",
            useDefineForClassFields: true,
            module: "ESNext",
            lib: ["ES2020", "DOM", "DOM.Iterable"],
            skipLibCheck: true,
            moduleResolution: "bundler",
            allowImportingTsExtensions: true,
            isolatedModules: true,
            moduleDetection: "force",
            noEmit: true,
            strict: true,
            noUnusedLocals: true,
            noUnusedParameters: true,
            noFallthroughCasesInSwitch: true
          },
          include: ["src"]
        }, null, 2) + "\n"
      },
      {
        path: "src/vite-env.d.ts",
        data: "/// <reference types=\"vite/client\" />\n"
      },
      {
        path: "src/main.ts",
        data: [
          "import \"./style.css\";",
          "import { label } from \"./message\";",
          "",
          "const app = document.querySelector<HTMLDivElement>(\"#app\");",
          "if (app) {",
          "  app.innerHTML = `",
          "    <h1>Vite + TypeScript</h1>",
          "    <div class=\"card\">",
          "      <button id=\"counter\" type=\"button\">${label}:1</button>",
          "    </div>",
          "  `;",
          "}",
          ""
        ].join("\n")
      },
      {
        path: "src/message.ts",
        data: "export const label = \"nuriteo-ts\";\n"
      },
      {
        path: "src/style.css",
        data: [
          ":root { font-family: system-ui, sans-serif; }",
          "body { margin: 0; }",
          "#app { max-width: 48rem; margin: 0 auto; padding: 2rem; text-align: center; }",
          ""
        ].join("\n")
      },
      {
        path: "package-lock.json",
        data: JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "node_modules/vite": { version: "6.2.0" },
            "node_modules/typescript": { version: "5.7.2" }
          }
        }, null, 2) + "\n"
      }
    ]
  };
}

function createMinimalTemplate(id: "minimal-npm" | "minimal-pnpm", manager: SupportedPackageManager): ProjectTemplate {
  const lockfile = manager === "pnpm"
    ? {
      path: "pnpm-lock.yaml",
      data: "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      vite: product-fixture\n"
    }
    : {
      path: "package-lock.json",
      data: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "node_modules/vite": { version: "6.2.0" }
        }
      }, null, 2) + "\n"
    };

  return {
    id,
    name: manager === "pnpm" ? "Minimal Vite (pnpm)" : "Minimal Vite (npm)",
    description: `Smallest Vite vanilla scaffold (${manager})`,
    packageManager: manager,
    framework: "vite-vanilla",
    files: [
      {
        path: "package.json",
        data: JSON.stringify({
          name: `minimal-${manager}`,
          private: true,
          version: "0.0.0",
          type: "module",
          ...(manager === "pnpm" ? { packageManager: "pnpm@9.15.9" } : {}),
          scripts: {
            dev: "vite --host 127.0.0.1",
            build: "vite build"
          },
          dependencies: {
            vite: "^6.2.0"
          }
        }, null, 2) + "\n"
      },
      {
        path: "index.html",
        data: "<!doctype html><html lang=\"en\"><head><meta charset=\"UTF-8\" /><meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" /><title>Minimal Vite</title></head><body><div id=\"app\"></div><script type=\"module\" src=\"/src/main.js\"></script></body></html>\n"
      },
      {
        path: "src/main.js",
        data: "import { label } from \"./message.js\";\nimport \"./style.css\";\n\nconst app = document.querySelector(\"#app\");\nif (app) app.textContent = `${label}:1`;\n"
      },
      {
        path: "src/message.js",
        data: `export const label = "minimal-${manager}";\n`
      },
      {
        path: "src/style.css",
        data: "body { margin: 0; font-family: system-ui, sans-serif; }\n#app { padding: 1rem; }\n"
      },
      lockfile
    ]
  };
}
