import assert from "node:assert/strict";

import { catalog } from "./catalog.ts";
import { copyPlain } from "./plain.ts";
import { searchDocs } from "./search.ts";


const routes = [
  "/",
  "/guide",
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

const corpus = catalog.map((entry) => `${copyPlain(entry.ko)}\n${copyPlain(entry.en)}`).join("\n");

for (const route of routes) {
  const entry = byPath.get(route);
  assert.ok(entry, route);
  for (const lang of ["ko", "en"] as const) {
    const copy = entry[lang];
    assert.ok(copy.title.trim(), `${route} ${lang} title`);
    assert.ok(copy.lead.trim(), `${route} ${lang} lead`);
    assert.ok(copy.nav.trim(), `${route} ${lang} nav`);
    assert.ok(copy.blocks.length > 0, `${route} ${lang} blocks`);
    assert.ok(copyPlain(copy).length > 80, `${route} ${lang} is too short to act on`);
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
assert.match(copyPlain(preview!.ko), /registerNuriteoPreviewServiceWorker\(\{ scriptUrl/);
assert.match(copyPlain(preview!.en), /registerNuriteoPreviewServiceWorker\(\{ scriptUrl/);
assert.match(copyPlain(preview!.ko), /services\.preview\.ports\(\)/);
assert.match(copyPlain(preview!.en), /services\.preview\.ports\(\)/);
assert.equal(copyPlain(preview!.ko).includes("listPorts"), false);
assert.equal(copyPlain(preview!.en).includes("listPorts"), false);
const adapters = byPath.get("/sdk/adapters");
assert.match(copyPlain(adapters!.ko), /listPorts/);
assert.match(copyPlain(adapters!.en), /listPorts/);

const guide = byPath.get("/guide");
assert.match(copyPlain(guide!.ko), /sandbox\.mjs/);
assert.match(copyPlain(guide!.en), /sandbox\.mjs/);
assert.match(copyPlain(guide!.ko), /fs-smoke/);
assert.equal(searchDocs("   ", "ko").length, 0);
assert.ok(searchDocs("createContainer", "ko").some((hit) => hit.path === "/sdk/container"));
assert.ok(searchDocs("Report a vulnerability", "en").some((hit) => hit.path === "/security"));
assert.equal(searchDocs("createContainer", "en").some((hit) => hit.path === "/sdk/preview"), false);

for (const entry of catalog) {
  for (const lang of ["ko", "en"] as const) {
    for (const block of entry[lang].blocks) {
      if (block.type !== "example") continue;
      assert.ok(block.title.trim(), `${entry.path} ${lang} example title`);
      assert.ok(block.text.trim(), `${entry.path} ${lang} example text`);
      assert.ok(block.code.trim(), `${entry.path} ${lang} example code`);
      assert.ok(block.result.trim(), `${entry.path} ${lang} example result`);
    }
  }
}
assert.ok(byPath.get("/sdk")!.ko.blocks.some((block) => block.type === "playground"));
assert.ok(byPath.get("/sdk")!.en.blocks.some((block) => block.type === "playground"));
const containerPage = byPath.get("/sdk/container");
assert.ok(containerPage!.ko.blocks.some((block) => block.type === "cases"));
assert.ok(containerPage!.en.blocks.some((block) => block.type === "cases"));
assert.match(copyPlain(containerPage!.ko), /spa-ready/);
assert.match(copyPlain(containerPage!.en), /next-ready/);
assert.match(copyPlain(containerPage!.ko), /loadContainerCase/);
for (const copy of [containerPage!.ko, containerPage!.en]) {
  const plain = copyPlain(copy);
  assert.match(plain, /replaced-entry/);
  assert.match(plain, /missing\.txt/);
  assert.match(plain, /examples\/spa\/src\/main\.js/);
  assert.match(plain, /examples\/next\/app\/page\.tsx/);
}

console.log(`docs content ok: ${routes.length} routes, ${corpus.length} chars`);
