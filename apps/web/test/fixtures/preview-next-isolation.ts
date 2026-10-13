import { createSubdomainPreviewBridge } from "../../src/runtime/subdomain-preview-bridge.ts";

const projectId = "019a4a82-1640-7000-8000-000000000031";
const ownerId = "019a4a82-1640-7000-8000-000000000032";
const identity = `${ownerId}:${projectId}`;
const bridge = await createSubdomainPreviewBridge({
  configuration: {
    status: "enabled",
    applicationOrigin: location.origin,
    baseDomain: "preview.localhost",
    protocol: location.protocol as "http:" | "https:",
    publicPort: location.port
  },
  internalProjectIdentity: identity,
  internalPreviewUrl: `${location.origin}/__preview/${encodeURIComponent(identity)}/3045/`,
  ownerId,
  ownerType: "user",
  projectId
});
const frame = document.createElement("iframe");
frame.title = "Isolated Next Preview";
frame.src = bridge.url;
frame.sandbox.add("allow-scripts", "allow-same-origin");
frame.allow = "cross-origin-isolated";
frame.referrerPolicy = "no-referrer";
frame.addEventListener("load", () => bridge.attach(frame.contentWindow));
document.body.dataset.previewUrl = bridge.url;
document.body.append(frame);
addEventListener("pagehide", () => { void bridge.dispose(); }, { once: true });
