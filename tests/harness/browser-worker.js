const encoder = new TextEncoder();

self.addEventListener("message", async (event) => {
  const payload = event.data;
  const stdout = [];
  const stderr = [];
  const files = new Map();
  const trace = [{ event: "start", at: Date.now() }];
  let status = 0;

  const consoleShim = {
    log(...args) {
      stdout.push(`${args.join(" ")}\n`);
    },
    error(...args) {
      stderr.push(`${args.join(" ")}\n`);
    }
  };
  const processShim = {
    exitCode: 0,
    exit(code = 0) {
      status = Number(code);
      throw new Error("__HARNESS_EXIT__");
    }
  };
  const fsShim = {
    writeFileSync(name, value) {
      files.set(name, encoder.encode(String(value)));
    }
  };

  try {
    const fn = new Function("console", "process", "fs", payload.source);
    await fn(consoleShim, processShim, fsShim);
    if (status === 0) status = Number(processShim.exitCode || 0);
  } catch (error) {
    if (error?.message !== "__HARNESS_EXIT__") {
      status = 1;
      stderr.push(`${error?.stack || error}\n`);
    }
  }

  trace.push({ event: "exit", at: Date.now(), status });

  const capturedFiles = {};
  for (const name of payload.assertFiles || []) {
    const bytes = files.get(name);
    if (bytes) {
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      capturedFiles[name] = btoa(binary);
    }
  }

  self.postMessage({
    kind: "browser-worker",
    status,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    files: capturedFiles,
    trace,
    fingerprint: {
      userAgent: navigator.userAgent,
      crossOriginIsolated: self.crossOriginIsolated
    }
  });
});
