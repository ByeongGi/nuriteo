import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const port = Number(process.env.PORT || 5173);

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp"
};

const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'"
].join("; ");

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

function resolveFile(pathname) {
  const cleanPath = pathname.replace(/^\/broken/, "");
  if (cleanPath === "/" || cleanPath === "") return path.join(publicRoot, "index.html");
  if (cleanPath.startsWith("/packages/") || cleanPath.startsWith("/workers/")) {
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
    res.writeHead(200, {
      ...(isolated ? isolationHeaders : {}),
      "Content-Security-Policy": csp,
      "Content-Type": mime[path.extname(file)] || "application/octet-stream"
    });
    res.end(bytes);
  });
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  console.log(`runtime-lab listening on http://127.0.0.1:${address.port}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
