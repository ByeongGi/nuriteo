import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin"
};

const productionCsp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'self' blob:";

function serviceWorkerHeaders() {
  return {
    name: "preview-sw-headers",
    configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.includes("preview-sw")) {
          res.setHeader("Service-Worker-Allowed", "/");
          res.setHeader("Cache-Control", "no-cache");
        }
        next();
      });
    },
    configurePreviewServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.includes("preview-sw")) {
          res.setHeader("Service-Worker-Allowed", "/");
          res.setHeader("Cache-Control", "no-cache");
        }
        next();
      });
    }
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    serviceWorkerHeaders()
  ],
  resolve: {
    alias: {
      "@cargo-container/preview-service": path.resolve(repoRoot, "packages/preview-service/src/index.ts"),
      "@cargo-container/browser-host": path.resolve(repoRoot, "packages/browser-host/src/index.ts"),
      "@cargo-container/preview": path.resolve(repoRoot, "packages/preview/src/index.ts"),
      "@cargo-container/node-runtime": path.resolve(repoRoot, "packages/node-runtime/src/index.ts"),
      "@cargo-container/protocol": path.resolve(repoRoot, "packages/protocol/src/index.ts")
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: true,
    headers: isolationHeaders,
    fs: {
      allow: [repoRoot]
    }
  },
  preview: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: true,
    headers: {
      ...isolationHeaders,
      "Content-Security-Policy": productionCsp
    }
  },
  worker: {
    format: "es"
  },
  optimizeDeps: {
    include: ["monaco-editor"]
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 9000
  }
});
