import assert from "node:assert/strict";
import { createWasmAdapterPolicy, ViteProductWorkflow } from "../../../../packages/node-runtime/src/index.ts";

export const dependencyArtifactWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  vitePackageArtifact: {
    version: "9.2.0-artifact",
    mounts: [
      {
        path: "package.json",
        data: JSON.stringify({ name: "vite", version: "9.2.0-artifact", type: "module", bin: { vite: "bin/vite.mjs" } })
      },
      {
        path: "bin/vite.mjs",
        data: "import '../dist/node/cli.mjs';\n"
      },
      {
        path: "dist/node/cli.mjs",
        data: "import { parseAst } from 'rolldown/parseAst';\nglobal.__viteRegisterBuild?.({ command: 'build', outDir: parseAst('dist'), source: 'vite-cli' });\n"
      }
    ]
  },
  dependencyArtifacts: [
    {
      name: "rolldown",
      version: "1.2.0",
      mounts: [
        {
          path: "package.json",
          data: JSON.stringify({
            name: "rolldown",
            version: "1.2.0",
            type: "module",
            exports: {
              "./parseAst": "./parseAst.mjs"
            }
          })
        },
        {
          path: "parseAst.mjs",
          data: "export function parseAst(value) { return value; }\n"
        }
      ]
    }
  ]
});

const viteWasmPolicy = createWasmAdapterPolicy({
  adapters: [
    {
      name: "rolldown-wasi",
      path: "vendor/rolldown.wasm",
      sha256: "0".repeat(64),
      exports: {
        memory: "memory",
        parseAst: "function"
      }
    }
  ],
  candidateReplacements: [
    {
      package: "rolldown",
      adapterName: "rolldown-wasi",
      wasmPackage: "@rolldown/binding-wasm32-wasi",
      fallbackPolicy: "prefer-wasm",
      status: "candidate-test-policy"
    }
  ]
});

export const missingDependencyWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  vitePackageArtifact: dependencyArtifactWorkflow.vitePackageArtifact,
  wasmAdapterPolicy: viteWasmPolicy
});

missingDependencyWorkflow.install();

assert.deepEqual(missingDependencyWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan, {
  summary: {
    missingByKind: {
      "package-artifact": 0,
      "wasm-adapter-candidate": 1,
      "native-hold": 0
    },
    missingCount: 1,
    optionalCount: 0,
    satisfiedCount: 0
  },
  missing: [
    {
      artifactNames: ["rolldown", "@rolldown/binding-wasm32-wasi"],
      kind: "wasm-adapter-candidate",
      name: "rolldown",
      nextAction: "Materialize the JavaScript package surface and route native binding requests through an integrity-pinned WASM adapter.",
      specifiers: ["rolldown/parseAst"],
      wasm: {
        adapterName: "rolldown-wasi",
        fallbackPolicy: "prefer-wasm",
        status: "candidate-test-policy",
        wasmPackage: "@rolldown/binding-wasm32-wasi"
      }
    }
  ],
  optional: [],
  satisfied: []
});

const dependencyArtifactInstall = dependencyArtifactWorkflow.install();

assert.equal(dependencyArtifactInstall.packages.includes("rolldown"), true);

const dependencyArtifactReadiness = dependencyArtifactWorkflow.inspectRealCliReadiness();

assert.equal(
  dependencyArtifactReadiness.cliModuleGraph.issues.some((issue) => issue.specifier === "rolldown/parseAst"),
  false
);

assert.deepEqual(dependencyArtifactReadiness.dependencyMaterializationPlan, {
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

const dependencyArtifactExecution = await dependencyArtifactWorkflow.executeRealCli(["build"]);

assert.deepEqual(dependencyArtifactExecution.buildRegistrations, [
  {
    command: "build",
    outDir: "dist",
    source: "vite-cli"
  }
]);


const optionalDependencyWorkflow = new ViteProductWorkflow({
  manager: "pnpm",
  vitePackageArtifact: {
    version: "9.2.1-optional-deps",
    mounts: [
      {
        path: "package.json",
        data: JSON.stringify({ name: "vite", version: "9.2.1-optional-deps", type: "module", bin: { vite: "bin/vite.mjs" } })
      },
      {
        path: "bin/vite.mjs",
        data: "import '../dist/node/cli.mjs';\n"
      },
      {
        path: "dist/node/cli.mjs",
        data: "import 'lightningcss';\nglobal.__viteRegisterBuild?.({ command: 'build', outDir: 'dist', source: 'vite-cli' });\n"
      }
    ]
  }
});

optionalDependencyWorkflow.install();

const optionalDependencyPlan = optionalDependencyWorkflow.inspectRealCliReadiness().dependencyMaterializationPlan;

assert.deepEqual(optionalDependencyPlan.summary, {
  missingByKind: {
    "package-artifact": 0,
    "wasm-adapter-candidate": 0,
    "native-hold": 0
  },
  missingCount: 0,
  optionalCount: 1,
  satisfiedCount: 0
});

assert.deepEqual(optionalDependencyPlan.missing, []);

assert.deepEqual(optionalDependencyPlan.optional, [
  {
    kind: "optional-dependency-probe",
    nextAction: "Leave this dependency optional unless a project feature explicitly imports it.",
    specifier: "lightningcss"
  }
]);
