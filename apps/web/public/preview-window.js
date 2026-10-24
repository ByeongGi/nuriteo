const PREVIEW_WINDOW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const previewWindowId = new URL(location.href).searchParams.get("window");
const applicationOrigin = location.origin;
const previewRoot = document.querySelector("#preview-window");
const previewPorts = new Set();
let previewFrame = null;

if (!opener || !PREVIEW_WINDOW_ID.test(previewWindowId || "") || !(previewRoot instanceof HTMLElement)) {
  renderFailure();
} else {
  addEventListener("message", receiveMessage);
  opener.postMessage({ type: "nuriteo-preview-window:ready", previewWindowId, version: 1 }, applicationOrigin);
}

function receiveMessage(event) {
  if (event.source === opener && event.origin === applicationOrigin && isInitializeMessage(event.data)) {
    mountPreview(event.data);
    return;
  }
  if (!previewFrame || event.source !== previewFrame.contentWindow) return;
  const previewOrigin = previewFrame.src ? new URL(previewFrame.src).origin : null;
  if (event.origin !== previewOrigin) return;
  if (event.data?.type === "nuriteo-preview:connect" && event.ports.length === 1) {
    const channel = new MessageChannel();
    previewPorts.add(event.ports[0]);
    previewPorts.add(channel.port2);
    pipePorts(event.ports[0], channel.port2);
    opener.postMessage(event.data, applicationOrigin, [channel.port1]);
    return;
  }
  opener.postMessage(event.data, applicationOrigin, event.ports);
}

function mountPreview(message) {
  for (const port of previewPorts) port.close();
  previewPorts.clear();
  const frame = document.createElement("iframe");
  frame.allow = "cross-origin-isolated";
  frame.referrerPolicy = "no-referrer";
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.src = message.url;
  frame.title = "프로젝트 미리보기";
  previewFrame = frame;
  previewRoot.replaceChildren(frame);
  document.title = `${message.projectName} · 미리보기`;
}

function pipePorts(left, right) {
  left.onmessage = (event) => right.postMessage(event.data, event.ports);
  right.onmessage = (event) => left.postMessage(event.data, event.ports);
  left.start();
  right.start();
}

function isInitializeMessage(value) {
  return typeof value === "object" && value !== null
    && Object.keys(value).sort().join("|") === "previewWindowId|projectName|type|url|version"
    && value.type === "nuriteo-preview-window:initialize"
    && value.previewWindowId === previewWindowId
    && typeof value.projectName === "string"
    && typeof value.url === "string"
    && value.version === 1;
}

function renderFailure() {
  if (previewRoot) previewRoot.innerHTML = "<p>미리보기 창을 연결하지 못했습니다.</p>";
}
