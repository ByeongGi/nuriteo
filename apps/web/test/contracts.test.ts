import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseThemeMode, THEME_MODES } from "../src/lib/theme.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

testStandaloneAndDependencyContract();
testServerFirstBoundaries();
testThemeAndTokenContract();
testSafeAccessibleBoundaries();
testProductionBoundary();

function testStandaloneAndDependencyContract(): void {
  const packageJson = JSON.parse(read("package.json")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.equal(packageJson.dependencies.next, "15.5.26");
  assert.equal(packageJson.dependencies.react, "19.0.0");
  assert.equal(packageJson.devDependencies.tailwindcss, "4.3.3");
  for (const dependency of ["zustand", "@tanstack/react-query"] as const) {
    assert.equal(dependency in packageJson.dependencies, false, `${dependency} must not be installed`);
  }
  assert.match(read("next.config.ts"), /output:\s*"standalone"/u);
  assert.match(read("postcss.config.mjs"), /"@tailwindcss\/postcss"/u);
}

function testServerFirstBoundaries(): void {
  for (const serverFile of [
    "src/app/layout.tsx",
    "src/app/page.tsx",
    "src/app/loading.tsx",
    "src/app/setup/page.tsx",
    "src/app/sign-in/page.tsx"
  ] as const) {
    assert.doesNotMatch(read(serverFile), /["']use client["']/u, `${serverFile} must stay server-first`);
  }
  const clientFiles = findFiles("src").filter((file) => /["']use client["']/u.test(read(file)));
  assert.deepEqual(clientFiles.sort(), [
    "src/app/(authenticated)/access-tokens/token-console.tsx",
    "src/app/(authenticated)/admin/_components/integration-ca-console.tsx",
    "src/app/(authenticated)/admin/admin-navigation.tsx",
    "src/app/(authenticated)/admin/backups/backup-console.tsx",
    "src/app/(authenticated)/admin/git-providers/provider-console.tsx",
    "src/app/(authenticated)/admin/invitations/activation-invitations.tsx",
    "src/app/(authenticated)/admin/maintenance/maintenance-console.tsx",
    "src/app/(authenticated)/admin/mfa/policy-editor.tsx",
    "src/app/(authenticated)/admin/notifications/email-delivery-console.tsx",
    "src/app/(authenticated)/admin/oidc/provider-console.tsx",
    "src/app/(authenticated)/admin/operations/support-bundle-download.tsx",
    "src/app/(authenticated)/admin/registries/registry-console.tsx",
    "src/app/(authenticated)/admin/settings/admin-settings.tsx",
    "src/app/(authenticated)/admin/updates/update-readiness-console.tsx",
    "src/app/(authenticated)/identities/identity-connections.tsx",
    "src/app/(authenticated)/notifications/notification-center.tsx",
    "src/app/(authenticated)/organization-invitations/accept/accept-invitation.tsx",
    "src/app/(authenticated)/organizations/[organizationId]/teams/team-console.tsx",
    "src/app/(authenticated)/organizations/organization-console.tsx",
    "src/app/(authenticated)/projects/project-dashboard.tsx",
    "src/app/(authenticated)/projects/project-git-panel.tsx",
    "src/app/(authenticated)/projects/project-history-panel.tsx",
    "src/app/(authenticated)/projects/project-ide-shell.tsx",
    "src/app/_components/error-view.tsx",
    "src/app/activate/activation-form.tsx",
    "src/app/error.tsx",
    "src/app/examples/_components/fork-example-form.tsx",
    "src/app/examples/_components/published-example-preview.tsx",
    "src/app/global-error.tsx",
    "src/app/mfa/security.tsx",
    "src/app/sign-in/sign-in-form.tsx",
    "src/components/theme-selector.tsx",
    "src/components/ui/button.tsx",
    "src/lib/api/browser-client.ts",
    "src/lib/api/browser-security.ts",
    "src/lib/use-exclusive-mutation.ts"
  ]);
}

function testThemeAndTokenContract(): void {
  assert.deepEqual(THEME_MODES, ["system", "light", "dark"]);
  assert.equal(parseThemeMode("dark"), "dark");
  assert.equal(parseThemeMode("unexpected"), "system");

  const layout = read("src/app/layout.tsx");
  assert.match(layout, /data-theme-mode=\{themeMode\}/u);
  assert.doesNotMatch(layout, /suppressHydrationWarning|dangerouslySetInnerHTML/u);

  const selector = read("src/components/theme-selector.tsx");
  assert.match(selector, /document\.documentElement\.dataset\.themeMode/u);
  assert.match(selector, /SameSite=Lax/u);

  const tokens = read("src/styles/tokens.css");
  for (const contract of [
    'html[data-theme-mode="light"]',
    'html[data-theme-mode="dark"]',
    'html[data-theme-mode="system"]',
    "prefers-color-scheme: dark",
    "--n-color-bg-page",
    "--n-color-border-focus"
  ]) {
    assert.ok(tokens.includes(contract), `missing theme contract: ${contract}`);
  }
  const globals = read("src/styles/globals.css");
  assert.match(globals, /@import "tailwindcss"/u);
  assert.match(globals, /@theme inline/u);
  assert.match(globals, /:focus-visible/u);
  assert.match(globals, /prefers-reduced-motion: reduce/u);
}

function testSafeAccessibleBoundaries(): void {
  const layout = read("src/app/layout.tsx");
  assert.match(layout, /href="#main-content"/u);
  assert.match(layout, /Skip to main content/u);

  const loading = read("src/app/loading.tsx");
  assert.match(loading, /aria-busy="true"/u);
  assert.match(loading, /aria-live="polite"/u);

  const notFound = read("src/app/not-found.tsx");
  assert.match(notFound, /<h1/u);
  assert.match(notFound, /href="\/"/u);

  for (const errorFile of ["src/app/error.tsx", "src/app/global-error.tsx"] as const) {
    const source = read(errorFile);
    assert.doesNotMatch(source, /error\.message|error\.stack|JSON\.stringify\(error\)/u);
    assert.ok(source.includes("^[A-Za-z0-9_-]{1,128}$"), `${errorFile} must bound safe digests`);
  }
}

function testProductionBoundary(): void {
  for (const file of findFiles("src")) {
    const source = read(file);
    assert.doesNotMatch(source, /apps\/preview-service|service-backend|@nuriteo\/preview-service(?:\/|["'])/u, `${file} imports legacy code or a package-internal path`);
    assert.doesNotMatch(source, /from ["'](?:postgres|sea-orm|sqlx|@aws-sdk\/client-s3)["']/iu, `${file} crosses service storage boundary`);
    if (file.endsWith(".tsx") && file !== "src/app/layout.tsx") {
      assert.doesNotMatch(source, /#[\da-f]{3,8}\b/iu, `${file} bypasses semantic tokens`);
    }
  }

  const runtimeAdapter = read("src/runtime/runtime-adapter.ts");
  assert.match(runtimeAdapter, /from "@nuriteo\/workspace-runtime"/u);

  const loginRoute = read("src/app/api/v1/auth/sessions/route.ts");
  const meRoute = read("src/app/api/v1/me/route.ts");
  assert.match(loginRoute, /forwardCreateSession/u);
  assert.match(meRoute, /forwardCurrentUser/u);
  assert.doesNotMatch(`${loginRoute}\n${meRoute}`, /\[\.\.\.|params|pathname/u);

  const projectGitPanel = read("src/app/(authenticated)/projects/project-git-panel.tsx");
  assert.match(projectGitPanel, /type="password"/u);
  assert.match(projectGitPanel, /REAUTHENTICATION_REQUIRED/u);
  assert.match(projectGitPanel, /Sign in again to refresh recent authentication/u);
  assert.match(projectGitPanel, /field\.value = ""/u);
  assert.doesNotMatch(projectGitPanel, /localStorage|sessionStorage|indexedDB/u);
}

function findFiles(directory: string): string[] {
  const absoluteDirectory = path.join(webRoot, directory);
  return fs.readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(directory, entry.name);
    return entry.isDirectory() ? findFiles(relativePath) : [relativePath];
  });
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(webRoot, relativePath), "utf8");
}
