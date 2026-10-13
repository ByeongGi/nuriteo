import assert from "node:assert/strict";
import {
  detectPackageScripts,
  exportProjectZip,
  getProjectTemplate,
  importProjectZip,
  importPublicGitHubRepo,
  listProjectTemplates,
  materializeTemplate,
  materializeZip,
  parseGitHubRepoUrl
} from "../../browser-host/src/onboarding/index.ts";

const templates = listProjectTemplates();
assert.deepEqual(
  templates.map((entry) => entry.id),
  ["vite-react", "next-app", "vite-ts", "minimal-npm", "minimal-pnpm"]
);

const react = materializeTemplate("vite-react");
assert.equal(react.health.ok, true);
assert.equal(react.health.detection.packageManager, "pnpm");
assert.equal(react.health.detection.devScript, "dev");
assert.ok(react.store.listFiles().some((file) => file.path.endsWith("package.json")));

const detectionOverride = detectPackageScripts({
  packageJsonText: JSON.stringify({
    packageManager: "yarn@3.8.0",
    scripts: { build: "echo build" }
  }),
  files: ["package-lock.json", "pnpm-lock.yaml"],
  overrides: {
    packageManager: "npm",
    installCommand: "npm ci",
    devScript: "start"
  }
});
assert.equal(detectionOverride.packageManager, "npm");
assert.equal(detectionOverride.packageManagerSource, "override");
assert.equal(detectionOverride.installCommand, "npm ci");
assert.equal(detectionOverride.devScript, "start");
assert.ok(detectionOverride.diagnostics.some((entry) => entry.code === "ERR_IMPORT_UNSUPPORTED_PACKAGE_MANAGER"));
assert.ok(detectionOverride.diagnostics.some((entry) => entry.code === "ERR_IMPORT_LOCKFILE_CONFLICT"));

const yarnField = detectPackageScripts({
  packageJsonText: JSON.stringify({ packageManager: "yarn@1.22.22", scripts: { dev: "vite" } }),
  files: ["yarn.lock"]
});
assert.equal(yarnField.packageManager, "yarn");
assert.equal(yarnField.packageManagerSource, "packageManager-field");
assert.equal(yarnField.installCommand, "yarn install");
assert.equal(yarnField.diagnostics.some((entry) => entry.code === "ERR_IMPORT_UNSUPPORTED_PACKAGE_MANAGER"), false);

const yarnLock = detectPackageScripts({
  packageJsonText: JSON.stringify({ scripts: { dev: "vite" } }),
  files: ["yarn.lock"]
});
assert.equal(yarnLock.packageManager, "yarn");
assert.equal(yarnLock.packageManagerSource, "yarn-lock");

const missingScripts = detectPackageScripts({
  packageJsonText: JSON.stringify({ name: "no-scripts" }),
  files: ["package.json"]
});
assert.ok(missingScripts.diagnostics.some((entry) => entry.code === "ERR_IMPORT_MISSING_SCRIPT"));

const zipBytes = exportProjectZip({
  rootDirectory: "demo",
  files: getProjectTemplate("minimal-npm").files
});
const zipMaterialized = materializeZip(zipBytes);
assert.equal(zipMaterialized.source, "zip");
assert.equal(zipMaterialized.health.ok, true);
assert.equal(zipMaterialized.health.detection.packageManager, "npm");
assert.ok(zipMaterialized.files.some((file) => file.path === "package.json"));

const brokenZip = importProjectZip(new TextEncoder().encode("not-a-zip"));
assert.equal(brokenZip.files.length, 0);
assert.equal(brokenZip.diagnostics[0]?.code, "ERR_IMPORT_ARCHIVE_FORMAT");

const tooLarge = importProjectZip(new Uint8Array(16), { maxBytes: 8 });
assert.ok(
  tooLarge.diagnostics[0]?.code === "ERR_IMPORT_FILE_TOO_LARGE"
    || tooLarge.diagnostics[0]?.code === "ERR_ABUSE_ARCHIVE_SIZE",
  `unexpected oversized archive diagnostic: ${tooLarge.diagnostics[0]?.code}`
);

const parsed = parseGitHubRepoUrl("https://github.com/vitejs/vite/tree/main");
assert.equal(parsed.owner, "vitejs");
assert.equal(parsed.repo, "vite");
assert.equal(parsed.ref, "main");
assert.match(parsed.archiveUrl, /codeload\.github\.com\/vitejs\/vite\/zip\/refs\/heads\/main/);

const fakeZip = exportProjectZip({
  rootDirectory: "repo",
  files: [
    {
      path: "package.json",
      data: JSON.stringify({
        name: "github-fixture",
        scripts: { dev: "vite", build: "vite build" },
        packageManager: "pnpm@9.15.9"
      })
    },
    { path: "pnpm-lock.yaml", data: "lockfileVersion: '9.0'\n" },
    { path: "index.html", data: "<div id=\"app\"></div>\n" }
  ]
});

const github = await importPublicGitHubRepo("owner/repo", {
  fetchImpl: async () => new Response(fakeZip, {
    status: 200,
    headers: { "content-type": "application/zip" }
  })
});
assert.equal(github.diagnostics.length, 0);
assert.ok(github.files.some((file) => file.path === "package.json"));

const githubNetwork = await importPublicGitHubRepo("https://github.com/owner/repo", {
  fetchImpl: async () => new Response("missing", { status: 404 })
});
assert.equal(githubNetwork.diagnostics[0]?.code, "ERR_IMPORT_NETWORK");

console.log("project onboarding ok");
