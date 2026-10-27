import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseThemeMode, THEME_MODES } from "../src/lib/theme.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

testStandaloneAndDependencyContract();
testServerFirstBoundaries();
testThemeAndTokenContract();
testComponentOwnedStyleBoundaries();
testSafeAccessibleBoundaries();
testProductionBoundary();

function testStandaloneAndDependencyContract(): void {
  const packageJson = JSON.parse(read("package.json")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.equal(packageJson.dependencies.next, "15.5.26");
  assert.equal(packageJson.dependencies.react, "19.0.0");
  assert.equal(packageJson.dependencies["@tanstack/react-query"], "5.104.5");
  assert.equal(packageJson.dependencies["tailwind-variants"], "3.3.1");
  assert.equal("class-variance-authority" in packageJson.dependencies, false);
  assert.equal(packageJson.devDependencies.tailwindcss, "4.3.3");
  for (const dependency of ["zustand"] as const) {
    assert.equal(dependency in packageJson.dependencies, false, `${dependency} must not be installed`);
  }
  const providers = read("src/app/providers.tsx");
  assert.match(providers, /QueryClientProvider/u);
  assert.match(providers, /staleTime:\s*60_000/u);
  assert.match(read("src/app/sign-in/sign-in-form.tsx"), /useMutation/u);
  const buttonStyles = read("src/components/ui/button.styles.ts");
  assert.match(buttonStyles, /const buttonVariants = tv\(/u);
  assert.doesNotMatch(buttonStyles, /["']use client["']/u);
  assert.match(read("src/components/ui/badge.tsx"), /const badgeVariants = tv\(/u);
  const fieldSource = read("src/components/ui/field.tsx");
  assert.match(fieldSource, /@base-ui\/react\/field/u);
  assert.match(fieldSource, /@base-ui\/react\/select/u);
  assert.match(fieldSource, /const fieldVariants = tv\(/u);
  assert.match(read("src/components/ui/checkbox.tsx"), /@base-ui\/react\/checkbox/u);
  assert.match(read("src/components/ui/radio-group.tsx"), /@base-ui\/react\/radio-group/u);
  assert.match(read("src/components/ui/switch.tsx"), /@base-ui\/react\/switch/u);
  assert.match(read("src/components/ui/checkbox.tsx"), /const checkboxStyles = tv\(/u);
  assert.match(read("src/components/ui/number-field.tsx"), /@base-ui\/react\/number-field/u);
  assert.match(read("src/components/ui/search-field.tsx"), /#src\/components\/ui\/input\.tsx/u);
  assert.match(read("src/components/ui/textarea.tsx"), /<textarea/u);
  for (const uiFile of findFiles("src/components/ui").filter((file) => file.endsWith(".tsx"))) {
    assert.doesNotMatch(read(uiFile), /admin(?:-|_|\s)|project(?:-|_|\s)|workspace(?:-|_|\s)/iu, `${uiFile} must stay domain-neutral`);
  }
  const confirmationDialogSource = read("src/components/ui/confirmation-dialog.tsx");
  assert.match(confirmationDialogSource, /@base-ui\/react\/alert-dialog/u);
  assert.doesNotMatch(confirmationDialogSource, /addEventListener|role=["']alertdialog/u);
  const segmentedControlSource = read("src/components/ui/segmented-control.tsx");
  assert.match(segmentedControlSource, /@base-ui\/react\/toggle-group/u);
  assert.match(segmentedControlSource, /const segmentedControlStyles = tv\(/u);
  const uiConsumerFiles = findFiles("src").filter((file) => file.endsWith(".tsx") && !file.startsWith("src/components/ui/"));
  for (const sourceFile of uiConsumerFiles) {
    const source = read(sourceFile);
    assert.doesNotMatch(source, /<select(?:\s|>)/u, `${sourceFile} must use the Base UI select field`);
    assert.doesNotMatch(source, /<(?:button|textarea|details|summary)(?:\s|>)/u, `${sourceFile} must use a shared UI wrapper`);
    assert.doesNotMatch(source, /role=["'](?:tab|tablist|tabpanel)["']/u, `${sourceFile} must use the Base UI tabs wrapper`);
    for (const [input] of source.matchAll(/<input\b[^>]*>/gu)) {
      assert.match(input, /type=["']hidden["']/u, `${sourceFile} must wrap every visible input`);
    }
    assert.doesNotMatch(read(sourceFile), /["']@base-ui\/react(?:\/|["'])/u, `${sourceFile} must import Base UI through a shared wrapper`);
  }
  assert.match(read("src/app/sign-in/sign-in.styles.ts"), /slots:\s*\{/u);
  assert.match(read("next.config.ts"), /output:\s*"standalone"/u);
  assert.match(read("postcss.config.mjs"), /"@tailwindcss\/postcss"/u);
  const relativeSourceImport = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']\.\.?\//u;
  for (const sourceFile of findFiles("src").filter((file) => /\.tsx?$/u.test(file))) {
    if (sourceFile === "src/lib/qr-matrix.ts") continue;
    // Monaco language contributions and worker entry points must remain static
    // relative URLs so Next/Webpack can include the package-owned browser assets.
    if (sourceFile === "src/projects/project-monaco-editor.tsx") continue;
    assert.doesNotMatch(read(sourceFile), relativeSourceImport, `${sourceFile} must use the #src/* alias`);
  }
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
  const uiFiles = findFiles("src/components/ui").filter((file) => file.endsWith(".tsx"));
  for (const uiFile of uiFiles) {
    assert.match(read(uiFile), /["']use client["']/u, `${uiFile} must keep the Base UI client boundary`);
  }
  const nonUiClientFiles = clientFiles.filter((file) => !file.startsWith("src/components/ui/"));
  for (const clientFile of nonUiClientFiles) {
    assert.doesNotMatch(clientFile, /\/(?:layout|loading|page)\.tsx$/u, `${clientFile} must keep the route entry server-first`);
  }
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
  assert.doesNotMatch(globals, /\.confirmation-dialog(?:__|\s*\{)/u);
  assert.doesNotMatch(globals, /\.product-segments button/u);
  assert.match(globals, /prefers-reduced-motion: reduce/u);
}

function testComponentOwnedStyleBoundaries(): void {
  const authenticatedShell = read("src/app/(authenticated)/authenticated-shell-frame.tsx");
  const authenticatedNavigation = read("src/app/(authenticated)/authenticated-navigation.tsx");
  const projectDashboard = read("src/projects/project-dashboard.tsx");
  const adminShell = read("src/app/(admin)/admin/admin-shell-frame.tsx");
  const adminNavigation = read("src/app/(admin)/admin/admin-navigation.tsx");
  const globals = read("src/styles/globals.css");

  for (const [name, source] of [
    ["authenticated shell", authenticatedShell],
    ["authenticated navigation", authenticatedNavigation],
    ["project dashboard", projectDashboard],
    ["admin shell", adminShell],
    ["admin navigation", adminNavigation]
  ] as const) {
    assert.match(source, /from "tailwind-variants"/u, `${name} must own its Tailwind Variants styles`);
    assert.match(source, /const \w+Styles = tv\(\{[\s\S]+slots:\s*\{/u, `${name} must expose named TV slots`);
  }

  assert.doesNotMatch(
    authenticatedShell,
    /className="authenticated-(?:shell|navigation)[^"]*"/u,
    "the authenticated shell must not depend on legacy global classes"
  );
  assert.doesNotMatch(
    authenticatedNavigation,
    /className="authenticated-navigation[^"]*"/u,
    "authenticated navigation must not depend on legacy global classes"
  );
  assert.doesNotMatch(
    projectDashboard,
    /className="project-(?:page|layout|sidebar|catalog|record)[^"]*"/u,
    "the project catalog must render through its TV slots"
  );
  assert.doesNotMatch(
    adminShell,
    /className="admin-(?:application-shell|sidebar|mobile-header|shell)[^"]*"/u,
    "the admin shell must not depend on legacy global classes"
  );
  assert.doesNotMatch(
    adminNavigation,
    /className="admin-navigation[^"]*"/u,
    "admin navigation must not depend on legacy global classes"
  );

  assert.doesNotMatch(globals, /unlayered\s+project\s+override/iu);
  assert.doesNotMatch(
    globals,
    /\.project-catalog__pagination\b/u,
    "globals.css must not own the Project catalog pagination override"
  );
}

function testSafeAccessibleBoundaries(): void {
  const layout = read("src/app/layout.tsx");
  assert.match(layout, /href="#main-content"/u);
  assert.match(layout, /본문으로 건너뛰기/u);

  const loading = read("src/app/loading.tsx");
  assert.match(loading, /aria-busy="true"/u);
  assert.match(loading, /aria-live="polite"/u);

  const notFound = read("src/app/not-found.tsx");
  assert.match(notFound, /<NotFoundState/u);

  const productEntryShell = read("src/app/_components/product-entry-shell.tsx");
  assert.match(productEntryShell, /<h1 className=\{styles\.title\(\)\} id=\{titleId\}>/u);
  assert.match(productEntryShell, /aria-labelledby=\{titleId\}/u);

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
      assert.doesNotMatch(source, /(?<!&)#[\da-f]{3,8}\b/iu, `${file} bypasses semantic tokens`);
    }
  }

  const runtimeAdapter = read("src/runtime/runtime-adapter.ts");
  assert.match(runtimeAdapter, /from "@nuriteo\/workspace-runtime"/u);

  const loginRoute = read("src/app/api/v1/auth/sessions/route.ts");
  const logoutRoute = read("src/app/api/v1/auth/session/route.ts");
  const meRoute = read("src/app/api/v1/me/route.ts");
  assert.match(loginRoute, /forwardCreateSession/u);
  assert.match(logoutRoute, /forwardDeleteSession/u);
  assert.match(meRoute, /forwardCurrentUser/u);
  assert.doesNotMatch(`${loginRoute}\n${logoutRoute}\n${meRoute}`, /\[\.\.\.|params|pathname/u);

  const projectGitPanel = read("src/projects/project-git-panel.tsx");
  assert.match(projectGitPanel, /type="password"/u);
  assert.match(projectGitPanel, /REAUTHENTICATION_REQUIRED/u);
  assert.match(projectGitPanel, /최근 인증을 갱신하려면 다시 로그인/u);
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
