import assert from "node:assert/strict";

import { createPreviewWorkflowController } from "../src/controller.ts";

const fetched: string[] = [];
const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
Object.defineProperty(globalThis, "location", {
  configurable: true,
  value: { origin: "http://127.0.0.1:3000" }
});
const navigatorValue = globalThis.navigator as Navigator & { serviceWorker?: unknown };
const previousServiceWorker = Object.getOwnPropertyDescriptor(navigatorValue, "serviceWorker");
Object.defineProperty(navigatorValue, "serviceWorker", {
  configurable: true,
  value: {
    addEventListener() {},
    removeEventListener() {},
    async register() { return {}; },
    ready: Promise.resolve({})
  }
});

const controller = createPreviewWorkflowController({
    packageFetch: async (input, init) => {
      fetched.push(String(input));
      return fetch(input, init);
    },
    previewPort: 3000,
    workspaceProjectId: "next-repro"
  });

try {
  controller.loadTemplate("next-app", { label: "Nextjs" });
  const snapshot = await controller.runPreview();
  assert.equal(snapshot.phase, "hmr_connected");
  assert.match(snapshot.previewUrl ?? "", /\/__preview\/.+\/3000\/$/u);
  assert.deepEqual(fetched, []);
  assert.equal(snapshot.lastError, null);
  const preview = snapshot.workflow?.preview("/");
  assert.equal(preview?.statusCode, 200);
  assert.match(String(preview?.body ?? ""), /Nextjs|next/i);
} finally {
  controller.dispose();
  if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
  else delete (globalThis as { location?: unknown }).location;
  if (previousServiceWorker) Object.defineProperty(navigatorValue, "serviceWorker", previousServiceWorker);
  else delete navigatorValue.serviceWorker;
}
