import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appRoot, "../..");
const publicRoot = path.join(appRoot, "public");
const port = Number(process.env.PORT || 5180);

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin"
};

const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "frame-src 'self' blob:"
].join("; ");

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8"
};

const browserImportAliases = new Map([
  ["@cargo-container/browser-host", "/packages/browser-host/src/index.ts"],
  ["@cargo-container/browser-host/supervisor", "/packages/browser-host/src/supervisor.ts"],
  ["@cargo-container/node-runtime", "/packages/node-runtime/src/index.ts"],
  ["@cargo-container/preview", "/packages/preview/src/index.ts"],
  ["@cargo-container/preview-service", "/packages/preview-service/src/index.ts"],
  ["@cargo-container/preview-service/controller", "/packages/preview-service/src/controller.ts"],
  ["@cargo-container/protocol", "/packages/protocol/src/index.ts"],
  ["@cargo-container/sdk", "/packages/sdk/src/index.ts"],
  ["fflate", "/node_modules/fflate/esm/browser.js"],
  ["typescript", "/shims/typescript.js"]
]);

function rewriteBrowserImports(source) {
  let output = source;
  for (const [specifier, browserPath] of browserImportAliases) {
    output = output
      .replaceAll(`from "${specifier}"`, `from "${browserPath}"`)
      .replaceAll(`from '${specifier}'`, `from '${browserPath}'`)
      .replaceAll(`import("${specifier}")`, `import("${browserPath}")`)
      .replaceAll(`import('${specifier}')`, `import('${browserPath}')`);
  }
  return output;
}

function toBrowserJavaScript(source, filename) {
  if (path.extname(filename) !== ".ts") return source;
  const output = ts.transpileModule(source.toString("utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2024,
      useDefineForClassFields: true
    },
    fileName: filename
  }).outputText;
  return rewriteBrowserImports(output);
}

function resolveFile(pathname) {
  if (pathname === "/" || pathname === "") return path.join(publicRoot, "index.html");
  if (
    pathname.startsWith("/packages/")
    || pathname.startsWith("/workers/")
    || pathname.startsWith("/node_modules/fflate/")
  ) {
    return path.join(repoRoot, pathname.slice(1));
  }
  if (pathname === "/shims/typescript.js") {
    return path.join(publicRoot, "shims/typescript.js");
  }
  return path.join(publicRoot, pathname.slice(1));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  // Preview routes are claimed by the product service worker in the browser.
  if (url.pathname.startsWith("/__preview/")) {
    res.writeHead(503, {
      ...isolationHeaders,
      "Content-Security-Policy": csp,
      "Content-Type": "text/plain; charset=utf-8"
    });
    res.end("Preview service worker is not controlling this request yet.");
    return;
  }

  const file = resolveFile(url.pathname);
  if (!file.startsWith(repoRoot + path.sep) && !file.startsWith(publicRoot + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  fs.readFile(file, (error, bytes) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const body = toBrowserJavaScript(bytes, file);
    const headers = {
      ...isolationHeaders,
      "Content-Security-Policy": csp,
      "Content-Type": mime[path.extname(file)] || "application/octet-stream"
    };
    if (url.pathname.endsWith("preview-sw.ts") || url.pathname.endsWith("preview-sw.js")) {
      headers["Service-Worker-Allowed"] = "/";
      headers["Cache-Control"] = "no-cache";
    }
    res.writeHead(200, headers);
    res.end(body);
  });
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  console.log(`preview-service listening on http://127.0.0.1:${address.port}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
