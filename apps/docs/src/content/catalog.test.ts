import assert from "node:assert/strict";

import { catalog } from "./catalog.ts";
import type { Block, Copy } from "./types.ts";

const routes = [
  "/",
  "/install",
  "/install/source",
  "/install/compose",
  "/install/kubernetes",
  "/install/admin",
  "/install/upgrade",
  "/use",
  "/use/projects",
  "/use/preview",
  "/use/files",
  "/limits",
  "/sdk",
  "/sdk/install",
  "/sdk/container",
  "/sdk/filesystem",
  "/sdk/packages",
  "/sdk/processes",
  "/sdk/preview",
  "/sdk/projects",
  "/sdk/webcontainer",
  "/sdk/adapters",
  "/security",
  "/develop",
  "/develop/repository",
  "/develop/local",
  "/develop/checks",
  "/develop/sdk-release"
];

const byPath = new Map(catalog.map((entry) => [entry.path, entry]));
assert.deepEqual(catalog.map((entry) => entry.path), routes);

const corpus = catalog.map((entry) => `${plain(entry.ko)}\n${plain(entry.en)}`).join("\n");

for (const route of routes) {
  const entry = byPath.get(route);
  assert.ok(entry, route);
  for (const lang of ["ko", "en"] as const) {
    const copy = entry[lang];
    assert.ok(copy.title.trim(), `${route} ${lang} title`);
    assert.ok(copy.lead.trim(), `${route} ${lang} lead`);
    assert.ok(copy.nav.trim(), `${route} ${lang} nav`);
    assert.ok(copy.blocks.length > 0, `${route} ${lang} blocks`);
    assert.ok(plain(copy).length > 80, `${route} ${lang} is too short to act on`);
  }
}

assert.match(corpus, /셀프호스트/);
assert.match(corpus, /self-hosted/i);
assert.match(corpus, /Apache-2\.0/);
assert.match(corpus, /@nuriteo\/sdk@beta/);
assert.match(corpus, /0\.0\.0/);
assert.match(corpus, /scriptUrl/);
assert.match(corpus, /systemWorkerUrl/);
assert.match(corpus, /processWorkerUrl/);
assert.match(corpus, /systemWasmUrl/);
assert.match(corpus, /앞으로만/);
assert.match(corpus, /forward-only/);
assert.match(corpus, /72시간/);
assert.match(corpus, /72 hours/);
assert.match(corpus, /자동으로 업로드되지 않습니다/);
assert.match(corpus, /not uploaded automatically/);
assert.match(corpus, /공개 가입 페이지는 없습니다/);
assert.match(corpus, /no public signup/);
assert.match(corpus, /require-corp/);
assert.match(corpus, /fs-smoke/);
assert.match(corpus, /docker compose -f deploy\/compose\/compose\.yaml up/);
assert.match(corpus, /helm upgrade --install nuriteo deploy\/charts\/nuriteo/);
assert.match(corpus, /pnpm dev/);
assert.match(corpus, /데스크톱 Chrome/);
assert.match(corpus, /desktop Chrome/);
assert.equal(corpus.includes("serviceWorkerUrl"), false);

assert.doesNotMatch(corpus, /-----BEGIN /);
assert.doesNotMatch(corpus, /npm_[A-Za-z0-9]{10,}/);
assert.doesNotMatch(corpus, /ghp_[A-Za-z0-9]/);
assert.doesNotMatch(corpus, /AKIA[0-9A-Z]{16}/);
assert.doesNotMatch(corpus, /postgres:\/\/[^:\s]+:[^@\s]+@/);

const preview = byPath.get("/sdk/preview");
assert.match(plain(preview!.ko), /registerNuriteoPreviewServiceWorker\(\{ scriptUrl/);
assert.match(plain(preview!.en), /registerNuriteoPreviewServiceWorker\(\{ scriptUrl/);
assert.match(plain(preview!.ko), /services\.preview\.ports\(\)/);
assert.match(plain(preview!.en), /services\.preview\.ports\(\)/);
assert.equal(plain(preview!.ko).includes("listPorts"), false);
assert.equal(plain(preview!.en).includes("listPorts"), false);
const adapters = byPath.get("/sdk/adapters");
assert.match(plain(adapters!.ko), /listPorts/);
assert.match(plain(adapters!.en), /listPorts/);

console.log(`docs content ok: ${routes.length} routes, ${corpus.length} chars`);

function plain(copy: Copy): string {
  return [copy.nav, copy.eyebrow, copy.title, copy.lead, ...copy.blocks.map(blockText)].join("\n");
}

function blockText(block: Block): string {
  if (block.type === "p" || block.type === "h2" || block.type === "code") return block.text;
  if (block.type === "ul") return block.items.join("\n");
  if (block.type === "links") return block.items.map((item) => `${item.label} ${item.to}`).join("\n");
  return [block.columns.join(" "), ...block.rows.map((row) => row.join(" "))].join("\n");
}
