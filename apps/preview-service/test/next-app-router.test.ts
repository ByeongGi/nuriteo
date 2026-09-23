import assert from "node:assert/strict";
import { NextProductWorkflow } from "../../../packages/node-runtime/src/frameworks/next-workflow.ts";
import { createPreviewWorkflowController } from "../../../packages/preview-service/src/index.ts";

const workflow = new NextProductWorkflow({ manager: "pnpm", initialTitle: "Next.js" });
workflow.install();
workflow.startDevServerFromPackageScript("dev");

const home = workflow.preview("/");
assert.equal(home.statusCode, 200);
assert.match(home.body, /Next\.js/);
assert.match(home.body, /_next\/static\/chunks\/app\.js/);

const about = workflow.preview("/about");
assert.equal(about.statusCode, 200);
assert.match(about.body, /About|__NEXT_PREVIEW_ROUTE__/);

const boot = workflow.preview("/_next/static/chunks/app.js");
assert.equal(boot.statusCode, 200);
assert.match(boot.body, /pageModuleUrl|createRoot/);

const page = workflow.preview("/app/page.js");
assert.equal(page.statusCode, 200);
assert.match(page.body, /Link|jsx|Next/);

const aboutPage = workflow.preview("/app/about/page.js");
assert.equal(aboutPage.statusCode, 200);
assert.match(aboutPage.body, /About/);

workflow.applySourceEdit(
  "app/page.tsx",
  "import Link from \"next/link\";\nexport default function Page(){return (<main><h1>Edited Home</h1><Link href=\"/about\">About</Link></main>);}\n"
);
const homeAfter = workflow.preview("/");
assert.match(homeAfter.body, /Edited Home/);

const build = workflow.buildFromPackageScript("build");
assert.ok(build.files.includes("out/index.html"));
assert.equal(build.cliEntrypoint, "/workspace/app/node_modules/next/dist/bin/next.cjs");

const cliWorkflow = new NextProductWorkflow({
  manager: "pnpm",
  port: 3010,
  nextPackageArtifact: {
    version: "15.1.0-test",
    mounts: [
      {
        path: "package.json",
        data: JSON.stringify({ name: "next", version: "15.1.0-test", bin: { next: "dist/bin/next" } })
      },
      {
        path: "dist/bin/next",
        data: [
          "#!/usr/bin/env node",
          "const command = process.argv[2];",
          "const port = Number(process.env.PORT || 3000);",
          "if (command === 'build') global.__nextRegisterBuild({ command: 'build', outputDirectory: '.next', source: 'next-cli' });",
          "else global.__nextRegisterDevServer({ command: command === 'start' ? 'start' : 'dev', host: '127.0.0.1', port, source: 'next-cli' });"
        ].join("\n")
      }
    ]
  }
});
const cliInstall = cliWorkflow.install();
assert.equal(cliInstall.nextPackageSource, "mounted-artifact");
const readiness = cliWorkflow.inspectRealCliReadiness();
assert.equal(readiness.status, "ready");
assert.equal(readiness.cliEntrypoint, "/workspace/app/node_modules/next/dist/bin/next");

const cliDev = await cliWorkflow.startDevServerFromCliExecution();
assert.equal(cliDev.source, "cli-execution");
assert.equal(cliDev.moduleTransform, "adapter");
assert.equal(cliDev.port, 3010);
assert.equal(cliDev.processStarted, true);

const cliBuild = await cliWorkflow.buildFromCliExecution();
assert.equal(cliBuild.command, "next build");
assert.equal(cliBuild.cliEntrypoint, "/workspace/app/node_modules/next/dist/bin/next");
assert.ok(cliBuild.files.includes("out/index.html"));

const cliStopped = cliWorkflow.stopDevServer();
assert.equal(cliStopped.running, false);
assert.equal(cliStopped.processExited, true);

const productionServer = await cliWorkflow.startProductionServerFromCliExecution();
assert.equal(productionServer.command, "next start");
assert.equal(productionServer.source, "cli-execution");
assert.equal(productionServer.port, 3010);
cliWorkflow.stopDevServer();

const controller = createPreviewWorkflowController();
const loaded = controller.loadTemplate("next-app");
assert.equal(loaded.template, "next-app");
assert.ok(loaded.project.listFiles().some((file) => file.path.endsWith("app/about/page.tsx")));

console.log("preview-service next-app-router test ok");
