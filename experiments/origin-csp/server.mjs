import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const port = Number(process.env.PORT || 0);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp"
};

const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "child-src 'self'",
  "frame-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'"
].join("; ");

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const isolated = !url.pathname.startsWith("/broken/");
  const pathname = url.pathname.replace(/^\/broken/, "") || "/index.html";
  const file = path.join(root, pathname === "/" ? "index.html" : pathname);

  if (!file.startsWith(root + path.sep)) {
    send(res, 403, { "Content-Type": "text/plain" }, "Forbidden");
    return;
  }

  fs.readFile(file, (error, bytes) => {
    if (error) {
      send(res, 404, { "Content-Type": "text/plain" }, "Not found");
      return;
    }
    const headers = {
      "Content-Type": mime[path.extname(file)] || "application/octet-stream",
      "Content-Security-Policy": csp
    };
    if (isolated) Object.assign(headers, isolationHeaders);
    send(res, 200, headers, bytes);
  });
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  console.log(`http://127.0.0.1:${address.port}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
