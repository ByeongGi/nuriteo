import fs from "node:fs";
import path from "node:path";

import { catalog } from "../src/content/catalog.ts";

const appDir = path.resolve(import.meta.dirname, "..");
const dist = path.join(appDir, "dist");
const shell = fs.readFileSync(path.join(dist, "index.html"), "utf8");

fs.writeFileSync(path.join(dist, "404.html"), shell);
fs.cpSync(path.join(appDir, "public/fonts"), path.join(dist, "fonts"), { recursive: true, dereference: true });

for (const entry of catalog) {
  const html = injectPage(shell, entry.ko.title, entry.ko.lead);
  const directory = entry.path === "/" ? dist : path.join(dist, entry.path.slice(1));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "index.html"), html);
}

function injectPage(document: string, title: string, lead: string): string {
  const safeTitle = escapeHtml(title);
  const safeLead = escapeHtml(lead);
  return document
    .replace("<title>NURITEO 문서</title>", `<title>${safeTitle} · NURITEO</title>`)
    .replace(
      '<div id="root"></div>',
      `<div id="root"><main class="page"><h1>${safeTitle}</h1><p class="lead">${safeLead}</p></main></div>`
    );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
