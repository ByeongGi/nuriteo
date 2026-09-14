import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp"
};

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

export function startHarnessServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = url.pathname === "/" ? "/tests/harness/browser-runner.html" : url.pathname;
    const file = path.join(repoRoot, pathname.slice(1));
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
        ...isolationHeaders,
        "Content-Type": mime[path.extname(file)] || "application/octet-stream"
      });
      res.end(bytes);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}
