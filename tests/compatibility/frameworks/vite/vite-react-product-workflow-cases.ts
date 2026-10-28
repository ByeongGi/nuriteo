import assert from "node:assert/strict";
import { applyNpmInstallPlan, applyPnpmStorePlan, createNpmInstallPlan, createPnpmStorePlan, createViteDependencyArtifactClosureFromWorkspace, createViteDependencyArtifactFromWorkspace, createViteDependencyArtifactsFromPlan, createViteDependencyArtifactsFromWorkspace, createVitePackageArtifactFromWorkspace, createWasmAdapterPolicy, MemoryPackageManagerWorkspace, mergeViteDependencyArtifacts, ViteProductWorkflow } from "../../../../packages/node-runtime/src/index.ts";
import { dependencyArtifactWorkflow, missingDependencyWorkflow } from "./vite-react-product-workflow-deps.ts";

const actualLikeViteDependencyWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  vitePackageArtifact: {
    version: "8.2.0-actual-like-deps",
    mounts: [
      {
        path: "package.json",
        data: JSON.stringify({
          name: "vite",
          version: "8.2.0-actual-like-deps",
          type: "module",
          bin: { vite: "bin/vite.mjs" },
          dependencies: {
            esbuild: "^0.27.2",
            lightningcss: "^1.33.0",
            picomatch: "^4.0.5",
            postcss: "^8.5.23",
            rolldown: "~1.2.0",
            tinyglobby: "^0.2.17"
          },
          peerDependenciesMeta: {
            tsx: { optional: true },
            yaml: { optional: true }
          }
        })
      },
      {
        path: "bin/vite.mjs",
        data: "import '../dist/node/cli.mjs';\n"
      },
      {
        path: "dist/node/cli.mjs",
        data: "import 'esbuild';\nimport 'lightningcss';\nimport 'picomatch';\nimport 'postcss';\nimport 'rolldown';\nimport 'tinyglobby';\nimport 'tsx/cjs/api';\nimport 'yaml';\n"
      }
    ]
  },
  wasmAdapterPolicy: createWasmAdapterPolicy({
    adapters: [
      {
        name: "rolldown-wasi",
        path: "vendor/rolldown.wasm",
        sha256: "0".repeat(64),
        exports: { memory: "memory" }
      },
      {
        name: "esbuild-wasm",
        path: "vendor/esbuild.wasm",
        sha256: "1".repeat(64),
        exports: { memory: "memory" }
      }
    ],
    candidateReplacements: [
      {
        package: "rolldown",
        adapterName: "rolldown-wasi",
        wasmPackage: "@rolldown/binding-wasm32-wasi",
        fallbackPolicy: "prefer-wasm"
      },
      {
        package: "esbuild",
        adapterName: "esbuild-wasm",
        wasmPackage: "esbuild-wasm",
        fallbackPolicy: "prefer-wasm"
      }
    ]
  })
});

actualLikeViteDependencyWorkflow.install();

const actualLikeDependencyPlan = actualLikeViteDependencyWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan;

assert.deepEqual(actualLikeDependencyPlan.summary, {
  missingByKind: {
    "package-artifact": 3,
    "wasm-adapter-candidate": 1,
    "native-hold": 0
  },
  missingCount: 4,
  optionalCount: 3,
  satisfiedCount: 0
});

assert.deepEqual(actualLikeDependencyPlan.missing.map((item) => [item.name, item.kind, item.artifactNames]), [
  ["picomatch", "package-artifact", ["picomatch"]],
  ["postcss", "package-artifact", ["postcss"]],
  ["rolldown", "wasm-adapter-candidate", ["rolldown", "@rolldown/binding-wasm32-wasi"]],
  ["tinyglobby", "package-artifact", ["tinyglobby"]]
]);

assert.deepEqual(actualLikeDependencyPlan.optional.map((item) => [item.specifier, item.kind]), [
  ["lightningcss", "optional-dependency-probe"],
  ["tsx/cjs/api", "optional-dependency-probe"],
  ["yaml", "optional-dependency-probe"]
]);


const installedDependencyWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/vendor/rolldown/package.json",
    data: JSON.stringify({
      name: "rolldown",
      version: "1.2.1-installed",
      type: "module",
      exports: {
        "./parseAst": "./parseAst.mjs"
      }
    })
  },
  {
    path: "/vendor/rolldown/parseAst.mjs",
    data: "export function parseAst(value) { return `installed:${value}`; }\n"
  }
]);

const installedDependencyArtifact = createViteDependencyArtifactFromWorkspace({
  reader: installedDependencyWorkspace,
  packageRoot: "/vendor/rolldown"
});

assert.equal(installedDependencyArtifact.name, "rolldown");

assert.equal(installedDependencyArtifact.version, "1.2.1-installed");

assert.deepEqual(installedDependencyArtifact.mounts.map((mount) => mount.path), [
  "package.json",
  "parseAst.mjs"
]);

const aliasDependencyWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/vendor/string-width-cjs/package.json",
    data: JSON.stringify({ name: "string-width", version: "4.2.3", main: "index.js" })
  },
  {
    path: "/vendor/string-width-cjs/index.js",
    data: "module.exports = () => 1;\n"
  }
]);

const aliasDependencyArtifact = createViteDependencyArtifactFromWorkspace({
  name: "string-width-cjs",
  packageRoot: "/vendor/string-width-cjs",
  reader: aliasDependencyWorkspace
});

assert.equal(aliasDependencyArtifact.name, "string-width-cjs");

assert.equal(aliasDependencyArtifact.version, "4.2.3");

const batchDependencyWorkspace = new MemoryPackageManagerWorkspace([
  ...installedDependencyArtifact.mounts.map((mount) => ({
    path: `/workspace/project/node_modules/rolldown/${mount.path}`,
    data: mount.data
  })),
  {
    path: "/workspace/project/node_modules/@rolldown/binding-wasm32-wasi/package.json",
    data: JSON.stringify({ name: "@rolldown/binding-wasm32-wasi", version: "1.2.1-wasm", type: "module" })
  },
  {
    path: "/workspace/project/node_modules/@rolldown/binding-wasm32-wasi/index.mjs",
    data: "export const binding = 'wasm';\n"
  },
  {
    path: "/workspace/project/node_modules/@scope/pkg/package.json",
    data: JSON.stringify({ name: "@scope/pkg", version: "3.4.5", type: "module" })
  },
  {
    path: "/workspace/project/node_modules/@scope/pkg/index.mjs",
    data: "export const ok = true;\n"
  }
]);

const batchDependencyArtifacts = createViteDependencyArtifactsFromWorkspace({
  reader: batchDependencyWorkspace,
  nodeModulesRoot: "/workspace/project/node_modules",
  names: ["rolldown", "rolldown", "@scope/pkg"]
});

assert.deepEqual(batchDependencyArtifacts.map((artifact) => [artifact.name, artifact.version]), [
  ["rolldown", "1.2.1-installed"],
  ["@scope/pkg", "3.4.5"]
]);

const planDependencyArtifacts = createViteDependencyArtifactsFromPlan({
  reader: batchDependencyWorkspace,
  nodeModulesRoot: "/workspace/project/node_modules",
  plan: missingDependencyWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan
});

assert.deepEqual(planDependencyArtifacts.map((artifact) => [artifact.name, artifact.version]), [
  ["rolldown", "1.2.1-installed"],
  ["@rolldown/binding-wasm32-wasi", "1.2.1-wasm"]
]);

const partialDependencyWorkspace = new MemoryPackageManagerWorkspace([
  ...installedDependencyArtifact.mounts.map((mount) => ({
    path: `/workspace/project/node_modules/rolldown/${mount.path}`,
    data: mount.data
  }))
]);

assert.throws(
  () => createViteDependencyArtifactsFromPlan({
    reader: partialDependencyWorkspace,
    nodeModulesRoot: "/workspace/project/node_modules",
    plan: missingDependencyWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan
  }),
  /@rolldown\/binding-wasm32-wasi/
);

const partialPlanDependencyArtifacts = createViteDependencyArtifactsFromPlan({
  reader: partialDependencyWorkspace,
  nodeModulesRoot: "/workspace/project/node_modules",
  plan: missingDependencyWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan,
  skipMissing: true
});

assert.deepEqual(partialPlanDependencyArtifacts.map((artifact) => [artifact.name, artifact.version]), [
  ["rolldown", "1.2.1-installed"]
]);

const installedDependencyWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  vitePackageArtifact: dependencyArtifactWorkflow.vitePackageArtifact,
  dependencyArtifacts: [installedDependencyArtifact]
});

installedDependencyWorkflow.install();

assert.deepEqual(installedDependencyWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan, {
  summary: {
    missingByKind: {
      "package-artifact": 0,
      "wasm-adapter-candidate": 0,
      "native-hold": 0
    },
    missingCount: 0,
    optionalCount: 0,
    satisfiedCount: 1
  },
  missing: [],
  optional: [],
  satisfied: ["rolldown"]
});

const installedDependencyExecution = await installedDependencyWorkflow.executeRealCli(["build"]);

assert.deepEqual(installedDependencyExecution.buildRegistrations, [
  {
    command: "build",
    outDir: "installed:dist",
    source: "vite-cli"
  }
]);


const binaryDependencyWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/project/node_modules/binary-probe/package.json",
    data: JSON.stringify({ name: "binary-probe", version: "1.0.0", main: "index.cjs" })
  },
  {
    path: "/workspace/project/node_modules/binary-probe/index.cjs",
    data: "const fs = require('fs');\nmodule.exports = fs.readFileSync(__dirname + '/probe.wasm').toString('hex');\n"
  },
  {
    path: "/workspace/project/node_modules/binary-probe/probe.wasm",
    data: "AAECA/8=",
    encoding: "base64"
  }
]);

const binaryDependencyArtifact = createViteDependencyArtifactFromWorkspace({
  reader: binaryDependencyWorkspace,
  packageRoot: "/workspace/project/node_modules/binary-probe"
});

assert.deepEqual(binaryDependencyArtifact.mounts.find((mount) => mount.path === "probe.wasm"), {
  path: "probe.wasm",
  data: "AAECA/8=",
  encoding: "base64"
});

const binaryDependencyWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  vitePackageArtifact: {
    version: "9.2.2-binary-dependency",
    mounts: [
      {
        path: "package.json",
        data: JSON.stringify({ name: "vite", version: "9.2.2-binary-dependency", type: "module", bin: { vite: "bin/vite.mjs" } })
      },
      {
        path: "bin/vite.mjs",
        data: "import '../dist/node/cli.mjs';\n"
      },
      {
        path: "dist/node/cli.mjs",
        data: "import probe from 'binary-probe';\nglobal.__viteRegisterBuild?.({ command: 'build', outDir: probe, source: 'vite-cli' });\n"
      }
    ]
  },
  dependencyArtifacts: [binaryDependencyArtifact]
});

binaryDependencyWorkflow.install();

const binaryDependencyExecution = await binaryDependencyWorkflow.executeRealCli(["build"]);

assert.equal(binaryDependencyExecution.exitCode, 0, binaryDependencyExecution.stderr);

assert.deepEqual(binaryDependencyExecution.buildRegistrations, [
  {
    command: "build",
    outDir: "00010203ff",
    source: "vite-cli"
  }
]);


const pureJsDependencyWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/project/node_modules/postcss/package.json",
    data: JSON.stringify({ name: "postcss", version: "8.5.23", type: "module", exports: { ".": "./lib/postcss.mjs" }, dependencies: { "manifest-only": "^1.0.0" } })
  },
  {
    path: "/workspace/project/node_modules/postcss/lib/postcss.mjs",
    data: "import { nanoid } from 'nanoid';\nimport { green } from 'picocolors';\nimport { SourceMapGenerator } from 'source-map-js';\nexport default function postcss(value) { return { css: `${green(value)}:${nanoid(4)}:${new SourceMapGenerator().kind}` }; }\n"
  },
  {
    path: "/workspace/project/node_modules/tinyglobby/package.json",
    data: JSON.stringify({ name: "tinyglobby", version: "0.2.17", type: "module", exports: { ".": "./dist/index.mjs" } })
  },
  {
    path: "/workspace/project/node_modules/tinyglobby/dist/index.mjs",
    data: "import { fdir } from 'fdir';\nimport picomatch from 'picomatch';\nexport function glob(pattern) { return `${new fdir().crawl(pattern)}:${picomatch(pattern)}`; }\n"
  },
  {
    path: "/workspace/project/node_modules/nanoid/package.json",
    data: JSON.stringify({ name: "nanoid", version: "3.3.16", type: "module", exports: { ".": "./index.js" } })
  },
  {
    path: "/workspace/project/node_modules/nanoid/index.js",
    data: "export function nanoid(size) { return `id-${size}`; }\n"
  },
  {
    path: "/workspace/project/node_modules/picocolors/package.json",
    data: JSON.stringify({ name: "picocolors", version: "1.1.1", type: "module", exports: { ".": "./picocolors.js" } })
  },
  {
    path: "/workspace/project/node_modules/picocolors/picocolors.js",
    data: "export function green(value) { return `green:${value}`; }\n"
  },
  {
    path: "/workspace/project/node_modules/source-map-js/package.json",
    data: JSON.stringify({ name: "source-map-js", version: "1.2.1", type: "module", exports: { ".": "./source-map.js" } })
  },
  {
    path: "/workspace/project/node_modules/source-map-js/source-map.js",
    data: "export class SourceMapGenerator { kind = 'map'; }\n"
  },
  {
    path: "/workspace/project/node_modules/fdir/package.json",
    data: JSON.stringify({ name: "fdir", version: "6.5.0", type: "module", exports: { ".": "./index.mjs" } })
  },
  {
    path: "/workspace/project/node_modules/fdir/index.mjs",
    data: "export class fdir { crawl(pattern) { return `crawl:${pattern}`; } }\n"
  },
  {
    path: "/workspace/project/node_modules/picomatch/package.json",
    data: JSON.stringify({ name: "picomatch", version: "4.0.5", type: "module", exports: { ".": "./index.js" } })
  },
  {
    path: "/workspace/project/node_modules/picomatch/index.js",
    data: "export default function picomatch(pattern) { return `match:${pattern}`; }\n"
  },
  {
    path: "/workspace/project/node_modules/manifest-only/package.json",
    data: JSON.stringify({ name: "manifest-only", version: "1.0.0" })
  },
  {
    path: "/workspace/project/node_modules/manifest-only/index.js",
    data: "module.exports = { ok: true };\n"
  }
]);

const pureJsViteArtifact = {
  version: "9.3.0-pure-js-deps",
  mounts: [
    {
      path: "package.json",
      data: JSON.stringify({ name: "vite", version: "9.3.0-pure-js-deps", type: "module", bin: { vite: "bin/vite.mjs" } })
    },
    {
      path: "bin/vite.mjs",
      data: "import '../dist/node/cli.mjs';\n"
    },
    {
      path: "dist/node/cli.mjs",
      data: "import postcss from 'postcss';\nimport { glob } from 'tinyglobby';\nconst output = postcss(glob('dist')).css;\nglobal.__viteRegisterBuild?.({ command: 'build', outDir: output, source: 'vite-cli' });\n"
    }
  ]
};

const pureJsInitialWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  vitePackageArtifact: pureJsViteArtifact
});

pureJsInitialWorkflow.install();

assert.deepEqual(pureJsInitialWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan.missing.map((item) => item.name), [
  "postcss",
  "tinyglobby"
]);

assert.deepEqual([...new Set(pureJsInitialWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan.missing.map((item) => item.kind))], [
  "package-artifact"
]);

assert.deepEqual(pureJsInitialWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan.summary, {
  missingByKind: {
    "package-artifact": 2,
    "wasm-adapter-candidate": 0,
    "native-hold": 0
  },
  missingCount: 2,
  optionalCount: 0,
  satisfiedCount: 0
});

const directPureJsArtifacts = createViteDependencyArtifactsFromPlan({
  reader: pureJsDependencyWorkspace,
  nodeModulesRoot: "/workspace/project/node_modules",
  plan: pureJsInitialWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan
});

const pureJsDirectWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  vitePackageArtifact: pureJsViteArtifact,
  dependencyArtifacts: directPureJsArtifacts
});

pureJsDirectWorkflow.install();

assert.deepEqual(pureJsDirectWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan.missing.map((item) => item.name), [
  "fdir",
  "nanoid",
  "picocolors",
  "picomatch",
  "source-map-js"
]);

assert.deepEqual([...new Set(pureJsDirectWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan.missing.map((item) => item.kind))], [
  "package-artifact"
]);

assert.deepEqual(pureJsDirectWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan.summary, {
  missingByKind: {
    "package-artifact": 5,
    "wasm-adapter-candidate": 0,
    "native-hold": 0
  },
  missingCount: 5,
  optionalCount: 0,
  satisfiedCount: 2
});

const transitivePureJsArtifacts = createViteDependencyArtifactsFromPlan({
  reader: pureJsDependencyWorkspace,
  nodeModulesRoot: "/workspace/project/node_modules",
  plan: pureJsDirectWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan
});

const mergedPureJsArtifacts = mergeViteDependencyArtifacts(directPureJsArtifacts, transitivePureJsArtifacts);

assert.deepEqual(mergedPureJsArtifacts.replaced, []);

const pureJsClosure = createViteDependencyArtifactClosureFromWorkspace({
  manager: "pnpm",
  reader: pureJsDependencyWorkspace,
  nodeModulesRoot: "/workspace/project/node_modules",
  vitePackageArtifact: pureJsViteArtifact
});

assert.deepEqual(pureJsClosure.iterations.map((iteration) => iteration.extracted), [
  ["postcss", "tinyglobby"],
  ["fdir", "manifest-only", "nanoid", "picocolors", "picomatch", "source-map-js"]
]);

assert.deepEqual(pureJsClosure.remainingPlan.missing, []);

assert.deepEqual(pureJsClosure.artifacts.map((artifact) => artifact.name), [
  "postcss",
  "tinyglobby",
  "fdir",
  "manifest-only",
  "nanoid",
  "picocolors",
  "picomatch",
  "source-map-js"
]);

const pureJsCompleteWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  vitePackageArtifact: pureJsViteArtifact,
  dependencyArtifacts: pureJsClosure.artifacts
});

pureJsCompleteWorkflow.install();

assert.deepEqual(pureJsCompleteWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan.missing, []);

assert.deepEqual(pureJsCompleteWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan.summary, {
  missingByKind: {
    "package-artifact": 0,
    "wasm-adapter-candidate": 0,
    "native-hold": 0
  },
  missingCount: 0,
  optionalCount: 0,
  satisfiedCount: 8
});

const pureJsExecution = await pureJsCompleteWorkflow.executeRealCli(["build"]);

assert.equal(pureJsExecution.exitCode, 0, pureJsExecution.stderr);

assert.deepEqual(pureJsExecution.buildRegistrations, [
  {
    command: "build",
    outDir: "green:crawl:dist:match:dist:id-4:map",
    source: "vite-cli"
  }
]);


const installedViteWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/vendor/vite/package.json",
    data: JSON.stringify({ name: "vite", version: "9.1.0-installed", type: "module", bin: { vite: "bin/vite.mjs" } })
  },
  {
    path: "/vendor/vite/bin/vite.mjs",
    data: "#!/usr/bin/env node\nimport '../dist/node/cli.mjs';\n"
  },
  {
    path: "/vendor/vite/dist/node/cli.mjs",
    data: "import { startDevServer } from './server.mjs';\nstartDevServer({ host: '127.0.0.1', port: Number(process.env.PORT || 5173) });\n"
  },
  {
    path: "/vendor/vite/dist/node/server.mjs",
    data: "export function startDevServer(options) {\n  global.__viteRegisterTransform?.({ mode: 'browser-esm', source: 'vite-cli', transformRequest(request) { return `// installed package transform:${request.path}\\n${request.source}`; } });\n  global.__viteRegisterHmrChannel?.({ channel: 'hmr', source: 'vite-cli', transport: 'loopback', sendUpdate(update) { global.__viteBroadcastHmr?.(update); return update; } });\n  global.__viteRegisterDevServer?.({ command: 'dev', host: options.host, port: options.port, source: 'vite-cli' });\n}\n"
  }
]);

const installedArtifact = createVitePackageArtifactFromWorkspace({
  reader: installedViteWorkspace,
  packageRoot: "/vendor/vite"
});

assert.equal(installedArtifact.version, "9.1.0-installed");

assert.deepEqual(installedArtifact.mounts.map((mount) => mount.path), [
  "bin/vite.mjs",
  "dist/node/cli.mjs",
  "dist/node/server.mjs",
  "package.json"
]);

const installedArtifactWorkflow = new ViteProductWorkflow({
  manager: "npm",
  port: 5301,
  vitePackageArtifact: installedArtifact
});

installedArtifactWorkflow.install();

const installedArtifactServer = await installedArtifactWorkflow.startDevServerFromCliExecution();

assert.equal(installedArtifactServer.source, "cli-execution");

const installedArtifactModule = await installedArtifactWorkflow.fetch("http://127.0.0.1:5301/src/main.jsx");

assert.match(await installedArtifactModule.text(), /installed package transform:\/src\/main\.jsx/);


const npmInstalledWorkspace = new MemoryPackageManagerWorkspace([
  ...installedArtifact.mounts.map((mount) => ({
    path: `/workspace/vite-package/${mount.path}`,
    data: mount.data
  })),
  {
    path: "/workspace/project/package.json",
    data: JSON.stringify({
      name: "vite-package-manager-artifact-fixture",
      version: "1.0.0",
      private: true,
      dependencies: {
        vite: "file:../vite-package"
      }
    })
  },
  {
    path: "/workspace/project/package-lock.json",
    data: JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: {
            vite: "file:../vite-package"
          }
        },
        "../vite-package": {
          version: "9.1.0-installed"
        },
        "node_modules/vite": {
          resolved: "../vite-package",
          link: true
        }
      }
    })
  }
]);

const installPlan = createNpmInstallPlan({
  cwd: "/workspace/project",
  reader: npmInstalledWorkspace
});

applyNpmInstallPlan(installPlan, npmInstalledWorkspace);

const npmInstalledArtifact = createVitePackageArtifactFromWorkspace({
  reader: npmInstalledWorkspace,
  packageRoot: "/workspace/project/node_modules/vite"
});

assert.equal(npmInstalledArtifact.version, "9.1.0-installed");

const npmInstalledArtifactWorkflow = new ViteProductWorkflow({
  manager: "npm",
  port: 5302,
  vitePackageArtifact: npmInstalledArtifact
});

npmInstalledArtifactWorkflow.install();

const npmInstalledServer = await npmInstalledArtifactWorkflow.startDevServerFromCliExecution();

assert.equal(npmInstalledServer.source, "cli-execution");

const npmInstalledModule = await npmInstalledArtifactWorkflow.fetch("http://127.0.0.1:5302/src/main.jsx");

assert.match(await npmInstalledModule.text(), /installed package transform:\/src\/main\.jsx/);


const pnpmInstalledWorkspace = new MemoryPackageManagerWorkspace([
  ...installedArtifact.mounts.map((mount) => ({
    path: `/workspace/packages/vite/${mount.path}`,
    data: mount.data
  })),
  {
    path: "/workspace/project/package.json",
    data: JSON.stringify({
      name: "vite-pnpm-artifact-fixture",
      version: "1.0.0",
      private: true,
      packageManager: "pnpm@9.15.9",
      dependencies: {
        vite: "workspace:*"
      }
    })
  },
  {
    path: "/workspace/project/pnpm-workspace.yaml",
    data: "packages:\n  - \"../packages/*\"\n"
  },
  {
    path: "/workspace/project/pnpm-lock.yaml",
    data: "lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      vite:\n        specifier: workspace:*\n        version: link:../packages/vite\n"
  }
]);

const pnpmPlan = createPnpmStorePlan({
  cwd: "/workspace/project",
  reader: pnpmInstalledWorkspace
});

applyPnpmStorePlan(pnpmPlan, pnpmInstalledWorkspace);

const pnpmInstalledArtifact = createVitePackageArtifactFromWorkspace({
  reader: pnpmInstalledWorkspace,
  packageRoot: "/workspace/project/node_modules/vite"
});

assert.equal(pnpmInstalledArtifact.version, "9.1.0-installed");

const pnpmInstalledArtifactWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  port: 5303,
  vitePackageArtifact: pnpmInstalledArtifact
});

pnpmInstalledArtifactWorkflow.install();

const pnpmInstalledServer = await pnpmInstalledArtifactWorkflow.startDevServerFromCliExecution();

assert.equal(pnpmInstalledServer.source, "cli-execution");

const pnpmInstalledModule = await pnpmInstalledArtifactWorkflow.fetch("http://127.0.0.1:5303/src/main.jsx");

assert.match(await pnpmInstalledModule.text(), /installed package transform:\/src\/main\.jsx/);


assert.throws(
  () => new ViteProductWorkflow({
    manager: "npm",
    vitePackageArtifact: {
      version: "bad",
      mounts: []
    }
  }).install(),
  (error) => error.code === "EVITEARTIFACTMANIFEST" && error.path === "/workspace/project/node_modules/vite/package.json"
);

assert.throws(
  () => new ViteProductWorkflow({
    manager: "npm",
    vitePackageArtifact: {
      version: "bad",
      mounts: [
        {
          path: "package.json",
          data: JSON.stringify({ name: "not-vite", version: "bad", type: "module", bin: { vite: "bin/vite.js" } })
        }
      ]
    }
  }).install(),
  (error) => error.code === "EVITEARTIFACTNAME" && error.path === "/workspace/project/node_modules/vite/package.json"
);

assert.throws(
  () => new ViteProductWorkflow({
    manager: "npm",
    vitePackageArtifact: {
      version: "bad",
      mounts: [
        {
          path: "package.json",
          data: JSON.stringify({ name: "vite", version: "bad", type: "module", bin: { vite: "missing/vite.js" } })
        }
      ]
    }
  }).install(),
  (error) => error.code === "EVITEARTIFACTBIN" && error.path === "/workspace/project/node_modules/vite/missing/vite.js"
);



