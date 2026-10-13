import assert from "node:assert/strict";
import {
  createPermissionManager,
  createPermissionRecoveryDiagnostic
} from "../../browser-host/src/index.ts";

const permissions = createPermissionManager({
  rules: [
    {
      scope: "network",
      action: "fetch",
      resourcePrefix: "https://blocked.example",
      decision: "deny"
    }
  ]
});

try {
  permissions.assertAllowed({
    scope: "network",
    action: "fetch",
    resource: "https://blocked.example/package.tgz",
    projectId: "project-a"
  });
  assert.fail("expected permission denial");
} catch (error) {
  assert.equal(error.code, "EPERMISSION");
  const recovery = createPermissionRecoveryDiagnostic(error, ["fetch token=npm_secret"]);
  assert.equal(recovery.diagnostic.code, "EPERMISSION");
  assert.equal(recovery.diagnostic.source, "permission:network");
  assert.match(recovery.diagnostic.message, /network:fetch/);
  assert.equal(recovery.recoveryPlan.blocked, false);
  assert.equal(recovery.recoveryPlan.supportBundleRecommended, true);
  assert.ok(recovery.recoveryPlan.actions.some((action) => action.kind === "retry"));
  assert.equal(recovery.supportBundle.environment.permissionScope, "network");
  assert.equal(recovery.supportBundle.environment.permissionProjectId, "project-a");
  assert.match(recovery.supportBundle.logs[0], /token=\[REDACTED\]/);
}

console.log("browser host permission diagnostics test ok");
