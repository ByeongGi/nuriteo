import assert from "node:assert/strict";

import { fileIconKind } from "../../apps/preview-service/src/lib/fileIcons.ts";
import { MENU_EXCLUDED_SCOPE, MENU_SUPPORT_SCOPE } from "../../apps/preview-service/src/lib/menuSupport.ts";
import { notificationForWorkflowEvent } from "../../apps/preview-service/src/lib/notifications.ts";
import { DEFAULT_SETTINGS, monacoTheme } from "../../apps/preview-service/src/lib/settings.ts";

assert.equal(fileIconKind("src/App.tsx"), "code");
assert.equal(fileIconKind("package.json"), "data");
assert.equal(fileIconKind("src/index.css"), "style");
assert.equal(fileIconKind("README.md"), "document");
assert.equal(fileIconKind("asset.bin"), "file");

assert.deepEqual([monacoTheme("dark"), monacoTheme("light"), monacoTheme("high-contrast")], [
  "vs-dark",
  "vs",
  "hc-black"
]);
assert.equal(DEFAULT_SETTINGS.iconTheme, "color");
assert.equal(DEFAULT_SETTINGS.editorMinimap, false);
assert.equal(DEFAULT_SETTINGS.wordWrap, false);

assert.deepEqual(Object.keys(MENU_SUPPORT_SCOPE), ["File", "Edit", "View"]);
assert.ok(MENU_SUPPORT_SCOPE.Edit.some((item) => item.includes("undo")));
assert.ok(MENU_EXCLUDED_SCOPE.includes("multi-root workspace management"));

const baseEvent = {
  detail: {},
  snapshot: { previewUrl: "https://preview.test/app", lastError: null }
};
assert.deepEqual(notificationForWorkflowEvent({ ...baseEvent, type: "preview-ready" }), {
  title: "Preview ready",
  message: "https://preview.test/app",
  level: "success"
});
assert.equal(notificationForWorkflowEvent({ ...baseEvent, type: "phase" }), null);
assert.equal(notificationForWorkflowEvent({
  ...baseEvent,
  type: "error",
  snapshot: { ...baseEvent.snapshot, lastError: { message: "boom" } }
})?.message, "boom");

console.log("preview-service IDE polish ok");
