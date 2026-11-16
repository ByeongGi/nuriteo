import assert from "node:assert/strict";
import fs from "node:fs";

import { editorLanguageForPath, editorLanguageLabel } from "../../src/projects/_utils/project-editor-language.ts";
import { DEFAULT_EDITOR_SETTINGS, parseEditorFontSize, parseEditorSettings } from "../../src/projects/_utils/project-editor-settings.ts";
import { DEPENDENCY_DECLARATION_LIMIT, PROJECT_TYPESCRIPT_MODEL_LIMIT, selectTypeScriptModelPaths } from "../../src/projects/_utils/project-typescript-models.ts";
import { packageNamesFromManifest, projectTypeScriptOptionsFromWorkspace, stripJsonComments } from "../../src/projects/_utils/project-typescript-options.ts";

assert.equal(editorLanguageForPath("src/App.tsx"), "typescript");
assert.equal(editorLanguageForPath("src/main.mts"), "typescript");
assert.equal(editorLanguageForPath("src/App.vue"), "html");
assert.equal(editorLanguageForPath("src/App.svelte"), "html");
assert.equal(editorLanguageForPath("src/pages/index.astro"), "html");
assert.equal(editorLanguageForPath("schema.graphql"), "graphql");
assert.equal(editorLanguageForPath("docs/guide.mdx"), "mdx");
assert.equal(editorLanguageForPath("pnpm-lock.yaml"), "yaml");
assert.equal(editorLanguageForPath(".env.local"), "ini");
assert.equal(editorLanguageForPath(".editorconfig"), "ini");
assert.equal(editorLanguageForPath("Dockerfile"), "plaintext");
assert.equal(editorLanguageForPath("scripts/build.py"), "plaintext");
assert.equal(editorLanguageForPath("src/main.rs"), "plaintext");
assert.equal(editorLanguageForPath("native/addon.go"), "plaintext");
assert.equal(editorLanguageLabel("src/App.vue"), "Vue");
assert.equal(editorLanguageLabel("src/App.tsx"), "TypeScript");
assert.equal(editorLanguageLabel(".env.production"), "환경 변수");
assert.equal(editorLanguageLabel("Dockerfile"), "텍스트");

const projectFiles = Array.from({ length: PROJECT_TYPESCRIPT_MODEL_LIMIT + 1 }, (_, index) => ({
  kind: "text" as const,
  path: `src/file-${String(index).padStart(4, "0")}.ts`
}));
const selectedModels = selectTypeScriptModelPaths({
  files: [
    ...projectFiles,
    { kind: "text", path: "src/open-me.ts" },
    { kind: "text", path: "node_modules/left-pad/index.d.ts" },
    { kind: "text", path: "node_modules/@types/react/index.d.ts" },
    { kind: "text", path: "node_modules/@types/react/jsx-runtime.d.ts" },
    { kind: "text", path: "node_modules/.pnpm/@types+react@18/node_modules/@types/react/index.d.ts" },
    { kind: "text", path: "node_modules/lodash/index.d.ts" },
    { kind: "text", path: "main.py" },
    { kind: "text", path: "Dockerfile" },
    { kind: "binary", path: "src/logo.png" }
  ],
  packageNames: new Set(["react"]),
  priorityPaths: ["src/open-me.ts"]
});
assert.equal(selectedModels[0], "src/open-me.ts");
assert.equal(selectedModels.includes("node_modules/@types/react/index.d.ts"), true);
assert.equal(selectedModels.includes("node_modules/@types/react/jsx-runtime.d.ts"), true);
assert.equal(selectedModels.includes("node_modules/left-pad/index.d.ts"), false);
assert.equal(selectedModels.includes("node_modules/lodash/index.d.ts"), false);
assert.equal(selectedModels.includes("node_modules/.pnpm/@types+react@18/node_modules/@types/react/index.d.ts"), false);
assert.equal(selectedModels.includes("main.py"), false);
assert.equal(selectedModels.includes("Dockerfile"), false);
assert.equal(selectedModels.filter((path) => !path.includes("node_modules")).length, PROJECT_TYPESCRIPT_MODEL_LIMIT);
assert.ok(selectedModels.filter((path) => path.includes("node_modules")).length <= DEPENDENCY_DECLARATION_LIMIT);

assert.deepEqual(packageNamesFromManifest(JSON.stringify({
  dependencies: { react: "19.0.0", "@types/react": "19.0.0" },
  devDependencies: { vite: "6.0.0" }
})), ["react", "vite"]);

const typescriptOptions = projectTypeScriptOptionsFromWorkspace((path) => {
  if (path === "tsconfig.json") {
    return `{
      // Vite 프로젝트 설정
      "extends": "./tsconfig.base.json",
      "compilerOptions": {
        "jsx": "react-jsx",
        "paths": { "@/*": ["src/*"] },
        "baseUrl": ".",
      }
    }`;
  }
  if (path === "tsconfig.base.json") {
    return `{
      "compilerOptions": {
        "strict": true,
        "target": "ES2022",
        "module": "ESNext",
        "lib": ["ES2022", "DOM", "DOM.Iterable"]
      }
    }`;
  }
  return undefined;
});
assert.equal(typescriptOptions.jsx, "react-jsx");
assert.equal(typescriptOptions.strict, true);
assert.equal(typescriptOptions.target, "esnext");
assert.equal(typescriptOptions.module, "esnext");
assert.deepEqual(typescriptOptions.lib, ["ES2022", "DOM", "DOM.Iterable"]);
assert.equal(typescriptOptions.baseUrl, ".");
assert.deepEqual(typescriptOptions.paths, { "@/*": ["src/*"] });

const ignoredPackageExtends = projectTypeScriptOptionsFromWorkspace((path) => {
  if (path === "tsconfig.json") return `{ "extends": "@tsconfig/vite/tsconfig.json", "compilerOptions": { "jsx": "react" } }`;
  return undefined;
});
assert.equal(ignoredPackageExtends.jsx, "react");
assert.equal(ignoredPackageExtends.strict, false);

assert.equal(stripJsonComments(`{ "keep": "http://example.test", /* drop */ "ok": true }`), `{ "keep": "http://example.test",  "ok": true }`);

assert.equal(parseEditorFontSize("14"), 14);
assert.equal(parseEditorFontSize("11"), DEFAULT_EDITOR_SETTINGS.fontSize);
assert.deepEqual(parseEditorSettings("not-json"), DEFAULT_EDITOR_SETTINGS);
assert.deepEqual(parseEditorSettings(JSON.stringify({ fontSize: 16, minimap: false, wordWrap: "on" })), {
  fontSize: 16,
  minimap: false,
  wordWrap: "on"
});

const editorSource = fs.readFileSync(new URL("../../src/projects/_components/project-monaco-editor.tsx", import.meta.url), "utf8");
assert.match(editorSource, /stickyScroll: \{ enabled: !isCompact, maxLineCount: STICKY_SCROLL_MAX_LINES \}/u);
assert.match(editorSource, /definitions\/yaml\/register\.js/u);
assert.match(editorSource, /definitions\/graphql\/register\.js/u);
assert.match(editorSource, /definitions\/mdx\/register\.js/u);
assert.doesNotMatch(editorSource, /definitions\/(?:python|rust|go|java|php|ruby|dockerfile|cpp|csharp)\//u);

const chromeSource = fs.readFileSync(new URL("../../src/projects/studio/_components/studio-shell-chrome.tsx", import.meta.url), "utf8");
assert.match(chromeSource, /글자 크기/u);
assert.match(chromeSource, /줄바꿈/u);
assert.match(chromeSource, /미니맵/u);

console.log("studio editor language ok");
