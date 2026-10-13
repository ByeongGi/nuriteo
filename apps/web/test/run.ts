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

await import("./auth-bff.test.ts");
await import("./audit-bff.test.ts");
await import("./access-token-ux.test.ts");
await import("./admin-settings-ux.test.ts");
await import("./maintenance-ux.test.ts");
await import("./admin-backups-ux.test.ts");
await import("./authenticated-shell.test.ts");
await import("./collaboration-ux.test.ts");
await import("./browser-client.test.ts");
await import("./contracts.test.ts");
await import("./entry-flow.test.ts");
await import("./git-bff.test.ts");
await import("./project-ux.test.ts");
await import("./public-examples.test.ts");
await import("./public-content-bff.test.ts");
await import("./public-preview-content.test.ts");
await import("./published-example-fork-bff.test.ts");
await import("./published-example-management-bff.test.ts");
await import("./save-upload-bff.test.ts");
await import("./history-ux.test.ts");
await import("./integration-ca-bff.test.ts");
await import("./mfa-ux.test.ts");
await import("./oidc-bff.test.ts");
await import("./registry-bff.test.ts");
await import("./team-bff.test.ts");
await import("./project-bundle-v1-validation.test.ts");
await import("./project-bundle-v1.test.ts");
await import("./project-bundle-v1-stream.test.ts");
await import("./project-content-resume.test.ts");
await import("./project-save.test.ts");
await import("./preview-origin.test.ts");
await import("./preview-binding-route.test.ts");
await import("./public-preview-binding-route.test.ts");
await import("./preview-service-worker.test.ts");
await import("./retryable-lazy-feature.test.ts");
await import("./runtime-adapter.test.ts");
await import("./workspace-start.test.ts");
await import("./runtime-assets.test.ts");
await import("./server-client.test.ts");

console.log("web tests ok");
