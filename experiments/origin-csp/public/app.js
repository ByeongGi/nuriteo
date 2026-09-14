const resultEl = document.getElementById("result");

function runWorker() {
  return new Promise((resolve) => {
    const worker = new Worker("/worker.js", { type: "module" });
    const timeout = setTimeout(() => resolve({ timeout: true }), 1500);
    worker.onmessage = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      clearTimeout(timeout);
      resolve({ error: event.message });
    };
  });
}

function runPreviewHandshake() {
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.src = "/preview.html";
    const state = { accepted: false, rejectedBadOrigin: false };
    const timeout = setTimeout(() => {
      frame.remove();
      resolve(state);
    }, 1500);

    window.addEventListener("message", function onMessage(event) {
      if (event.data?.type === "preview-ready") {
        state.accepted = event.origin === location.origin;
        window.dispatchEvent(new MessageEvent("message", {
          data: { type: "preview-ready-bad-origin" },
          origin: "https://attacker.invalid"
        }));
        return;
      }
      if (event.data?.type === "preview-ready-bad-origin") {
        state.rejectedBadOrigin = event.origin !== location.origin;
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        frame.remove();
        resolve(state);
      }
    });

    document.body.append(frame);
  });
}

const worker = await runWorker();
const preview = await runPreviewHandshake();

globalThis.__p0Result = {
  crossOriginIsolated,
  sharedArrayBufferType: typeof SharedArrayBuffer,
  worker,
  preview,
  inlineScriptRan: Boolean(globalThis.__inlineScriptRan)
};

resultEl.textContent = JSON.stringify(globalThis.__p0Result, null, 2);
