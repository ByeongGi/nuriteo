import assert from "node:assert/strict";
import { resolveViteHmrUrl } from "../../preview/src/index.ts";

const placeholderResolution = resolveViteHmrUrl({
  previewUrl: "http://127.0.0.1:5173/",
  clientSource: `
const socketProtocol = __HMR_PROTOCOL__ || (importMetaUrl.protocol === "https:" ? "wss" : "ws");
const hmrPort = __HMR_PORT__;
const socketHost = \`\${__HMR_HOSTNAME__ || importMetaUrl.hostname}:\${hmrPort || importMetaUrl.port}\${__HMR_BASE__}\`;
const wsToken = __WS_TOKEN__;
`
});

assert.equal(placeholderResolution.url, "ws://127.0.0.1:5173/");
assert.equal(placeholderResolution.protocol, "ws:");
assert.equal(placeholderResolution.token, null);

const transformedResolution = resolveViteHmrUrl({
  previewUrl: "https://preview.example.test/app/",
  clientSource: `
const socketProtocol = "wss";
const hmrPort = 5305;
const socketHost = \`\${"hmr.example.test" || importMetaUrl.hostname}:\${hmrPort || importMetaUrl.port}\${"/hmr/"}\`;
const wsToken = "token-123";
`
});

assert.equal(transformedResolution.url, "wss://hmr.example.test:5305/hmr/?token=token-123");
assert.equal(transformedResolution.protocol, "wss:");
assert.equal(transformedResolution.token, "token-123");

console.log("preview vite hmr url test ok");
