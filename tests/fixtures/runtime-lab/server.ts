import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const port = Number(process.env.PORT || 5173);

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp"
};

const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'"
].join("; ");

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

const browserImportAliases = new Map([
  ["@nuriteo/browser-host", "/packages/browser-host/src/index.ts"],
  ["@nuriteo/browser-host/supervisor", "/packages/browser-host/src/supervisor.ts"],
  ["@nuriteo/preview", "/packages/preview/src/index.ts"],
  ["@nuriteo/protocol", "/packages/protocol/src/index.ts"],
  ["@nuriteo/sdk", "/packages/sdk/src/index.ts"],
  ["fflate", "/node_modules/fflate/esm/browser.js"],
  ["typescript", "/shims/typescript.js"]
]);

function rewriteBrowserImports(source: string): string {
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

function toBrowserJavaScript(source: Buffer, filename: string): Buffer | string {
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

function resolveFile(pathname: string): string {
  const cleanPath = pathname.replace(/^\/broken/, "");
  if (cleanPath === "/" || cleanPath === "") return path.join(publicRoot, "index.html");
  if (cleanPath.startsWith("/runtime/")) {
    return path.join(repoRoot, "packages/workspace-runtime/assets", cleanPath.slice(1));
  }
  if (cleanPath.startsWith("/packages/") || cleanPath.startsWith("/workers/") || cleanPath.startsWith("/tests/") || cleanPath.startsWith("/node_modules/fflate/")) {
    return path.join(repoRoot, cleanPath.slice(1));
  }
  return path.join(publicRoot, cleanPath);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const isolated = !url.pathname.startsWith("/broken/");
  const file = resolveFile(url.pathname);

  if (!file.startsWith(repoRoot + path.sep)) {
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
    res.writeHead(200, {
      ...(isolated ? isolationHeaders : {}),
      "Content-Security-Policy": csp,
      "Content-Type": mime[path.extname(file)] || "application/octet-stream"
    });
    res.end(body);
  });
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("runtime-lab did not bind to a TCP port");
  }
  console.log(`runtime-lab listening on http://127.0.0.1:${address.port}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
