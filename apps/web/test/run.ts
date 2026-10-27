import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export {};

if (!process.execArgv.some((argument) => argument === "--conditions=react-server")) {
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", fileURLToPath(import.meta.url)],
    { stdio: "inherit" }
  );
  process.exit(result.status ?? 1);
}

await import("./auth/auth-bff.test.ts");
await import("./admin/audit-bff.test.ts");
await import("./account/access-token-ux.test.ts");
await import("./admin/admin-settings-ux.test.ts");
await import("./admin/maintenance-ux.test.ts");
await import("./admin/admin-backups-ux.test.ts");
await import("./auth/authenticated-shell.test.ts");
await import("./project/collaboration-ux.test.ts");
await import("./client/browser-client.test.ts");
await import("./shell/contracts.test.ts");
await import("./shell/nested-ternary.test.ts");
await import("./auth/entry-flow.test.ts");
await import("./integrations/git-bff.test.ts");
await import("./project-ux.test.ts");
await import("./public/public-examples.test.ts");
await import("./public/public-content-bff.test.ts");
await import("./public/public-preview-content.test.ts");
await import("./public/published-example-fork-bff.test.ts");
await import("./public/published-example-management-bff.test.ts");
await import("./project/save-upload-bff.test.ts");
await import("./project/history-ux.test.ts");
await import("./integrations/integration-ca-bff.test.ts");
await import("./auth/mfa-ux.test.ts");
await import("./auth/oidc-bff.test.ts");
await import("./integrations/registry-bff.test.ts");
await import("./account/team-bff.test.ts");
await import("./shell/ui-safety-ux.test.ts");
await import("./project/project-bundle-v1-validation.test.ts");
await import("./project/project-bundle-v1.test.ts");
await import("./project/project-bundle-v1-stream.test.ts");
await import("./project/project-content-resume.test.ts");
await import("./project/project-save.test.ts");
await import("./preview/preview-origin.test.ts");
await import("./preview/preview-address.test.ts");
await import("./preview/preview-binding-route.test.ts");
await import("./preview/public-preview-binding-route.test.ts");
await import("./preview/preview-service-worker.test.ts");
await import("./runtime/retryable-lazy-feature.test.ts");
await import("./studio/studio-explorer-files.test.ts");
await import("./studio/studio-content-replace.test.ts");
await import("./studio/studio-editor-tabs.test.ts");
await import("./runtime/runtime-adapter.test.ts");
await import("./runtime/workspace-start.test.ts");
await import("./runtime/runtime-assets.test.ts");
await import("./client/server-client.test.ts");

console.log("web tests ok");
