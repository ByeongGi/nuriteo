globalThis.__runHarnessWorker = (payload) => {
  return new Promise((resolve) => {
    const worker = new Worker("/tests/harness/browser-worker.js", { type: "module" });
    const timeout = setTimeout(() => {
      worker.terminate();
      resolve({
        kind: "browser-worker",
        status: 124,
        stdout: "",
        stderr: "timeout",
        files: {},
        trace: [{ event: "timeout", at: Date.now() }],
        fingerprint: {
          userAgent: navigator.userAgent,
          crossOriginIsolated
        }
      });
    }, 3000);

    worker.onmessage = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      resolve({
        kind: "browser-worker",
        status: 1,
        stdout: "",
        stderr: event.message,
        files: {},
        trace: [{ event: "worker-error", at: Date.now() }],
        fingerprint: {
          userAgent: navigator.userAgent,
          crossOriginIsolated
        }
      });
    };
    worker.postMessage(payload);
  });
};
