import assert from "node:assert/strict";
import { NextProductWorkflow } from "../../packages/node-runtime/src/frameworks/next-workflow.ts";
import { createPreviewWorkflowController } from "../../packages/preview-service/src/index.ts";

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

const controller = createPreviewWorkflowController();
const loaded = controller.loadTemplate("next-app");
assert.equal(loaded.template, "next-app");
assert.ok(loaded.project.listFiles().some((file) => file.path.endsWith("app/about/page.tsx")));

console.log("preview-service next-app-router test ok");
