import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const port = Number(process.env.PORT || 0);

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
  ".json": "application/json; charset=utf-8"
};

function resolveFile(pathname) {
  if (pathname === "/") return path.join(publicRoot, "index.html");
  if (pathname.startsWith("/experiments/worker-boot/public/")) {
    return path.join(repoRoot, pathname.slice(1));
  }
  if (
    pathname.startsWith("/packages/") ||
    pathname.startsWith("/workers/")
  ) {
    return path.join(repoRoot, pathname.slice(1));
  }
  return path.join(publicRoot, pathname);
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const file = resolveFile(url.pathname);

  if (!file.startsWith(repoRoot + path.sep)) {
    send(res, 403, { "Content-Type": "text/plain" }, "Forbidden");
    return;
  }

  fs.readFile(file, (error, bytes) => {
    if (error) {
      send(res, 404, { "Content-Type": "text/plain" }, "Not found");
      return;
    }
    send(res, 200, {
      ...isolationHeaders,
      "Content-Security-Policy": csp,
      "Content-Type": mime[path.extname(file)] || "application/octet-stream"
    }, bytes);
  });
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  console.log(`http://127.0.0.1:${address.port}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
