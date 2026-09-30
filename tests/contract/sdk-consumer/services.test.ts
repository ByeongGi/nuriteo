import assert from "node:assert/strict";
import {
  NuriteoServices,
  registerNuriteoPreviewServiceWorker,
  resolveNuriteoWorkerAssets,
  SdkError
} from "../../../packages/sdk/src/services.ts";
import { createNuriteoMountSnapshot, createNuriteoWebContainer } from "../../../packages/sdk/src/webcontainer.ts";

const files = new Map([["/workspace/a.txt", "alpha"]]);
const calls = [];
const traceEvents = [];
const subscriptionEvents = [];
let previewScript = null;

const services = new NuriteoServices({
  now: (() => {
    let value = 100;
    return () => value++;
  })(),
  filesystem: {
    async readFile(path) { return files.get(path) || ""; },
    async writeFile(path, data) { files.set(path, String(data)); },
    async readdir(path) {
      return [...files.keys()].filter((file) => file.startsWith(path)).map((file) => ({ path: file, type: "file" }));
    },
    async mkdir() {},
    async rm(path) { files.delete(path); },
    watch(_path, listener) {
      listener({ path: "/workspace/a.txt", type: "change" });
      return () => {};
    }
  },
  packageManager: {
    async install(options) { calls.push(["install", options]); return result("install"); },
    async run(script, options) { calls.push(["run", script, options]); return result(`run ${script}`); },
    async exec(binary, options) { calls.push(["exec", binary, options]); return result(`exec ${binary}`); }
  },
  preview: {
    async listPorts() { return [{ port: 5173, protocol: "http", url: "http://localhost:5173" }]; },
    setPreviewScript(script) { previewScript = script; },
    subscribe(listener) {
      listener({ type: "server-ready", port: 5173, url: "http://localhost:5173" });
      return () => {};
    }
  },
  project: {
    async exportProject() { return new TextEncoder().encode("archive"); },
    async importProject(value) { calls.push(["import", typeof value]); }
  },
  process: {
    async spawn(options) {
      calls.push(["spawn", options]);
      return {
        pid: 7,
        kill() {},
        async wait() { return result(options.command); }
      };
    }
  }
});

services.onTrace((event) => traceEvents.push(event));

assert.equal(await services.fs.readFile("/workspace/a.txt"), "alpha");
await services.fs.writeFile("/workspace/b.txt", "beta");
assert.equal((await services.fs.readdir("/workspace")).length, 2);
services.fs.watch("/workspace", (event) => subscriptionEvents.push(event));
assert.equal((await services.packages.install({ packageManager: "pnpm", args: ["--offline"] })).exitCode, 0);
assert.equal((await services.packages.run("build", { args: ["--mode", "test"] })).command, "run build");
assert.equal((await services.packages.exec("vite", { cwd: "/workspace" })).command, "exec vite");
assert.deepEqual(await services.preview.ports(), [{ port: 5173, protocol: "http", url: "http://localhost:5173" }]);
await services.preview.setPreviewScript("npm run dev");
services.preview.subscribe((event) => subscriptionEvents.push(event));
assert.equal(previewScript, "npm run dev");
assert.equal(new TextDecoder().decode(await services.projects.export()), "archive");
await services.projects.import("archive");
const process = await services.processes.spawn({ command: "vite", args: ["--host"] });
assert.equal(process.pid, 7);
assert.equal((await process.wait()).command, "vite");
assert.ok(traceEvents.every((event) => ["start", "success"].includes(event.phase)));
assert.equal(traceEvents.filter((event) => event.phase === "start").length, 11);
assert.equal(subscriptionEvents.length, 2);

const lifecycle = [];
const webContainer = createNuriteoWebContainer({
  services,
  workdirName: "project",
  coep: "credentialless",
  lifecycle: {
    async boot() { lifecycle.push("boot"); },
    async teardown() { lifecycle.push("teardown"); }
  }
});
await webContainer.boot();
await webContainer.mount({
  src: { directory: { "main.ts": { file: { contents: "export const value = 1;" } } } }
});
assert.equal(await webContainer.fs.readFile("/project/src/main.ts"), "export const value = 1;");
await webContainer.mount(createNuriteoMountSnapshot({ "README.md": "hello" }));
assert.equal(await webContainer.fs.readFile("/project/README.md"), "hello");
assert.equal((await webContainer.spawn("vite", ["--host"])).pid, 7);
assert.equal(webContainer.coep, "credentialless");
await webContainer.teardown();
assert.deepEqual(lifecycle, ["boot", "teardown"]);
await webContainer.teardown();
assert.deepEqual(lifecycle, ["boot", "teardown"]);

await assert.rejects(
  () => webContainer.mount({ schemaVersion: 1, format: "nuriteo-mount", files: [{ path: "../escape.txt", contents: "no" }] }),
  (error) => error instanceof SdkError && error.code === "ESDK_PATH_INVALID"
);
await assert.rejects(
  () => webContainer.mount({ schemaVersion: 1, format: "nuriteo-mount", files: [{ path: "invalid", contents: 1 }] }),
  (error) => error instanceof SdkError && error.code === "ESDK_INVALID_ARGUMENT"
);
await assert.rejects(
  () => webContainer.mount({ link: { symlink: "../target" } }),
  (error) => error instanceof SdkError && error.code === "ESDK_SYMLINK_UNSUPPORTED"
);
await assert.rejects(
  () => webContainer.mount({ schemaVersion: 2, format: "nuriteo-mount", files: [] }),
  (error) => error instanceof SdkError && error.code === "ESDK_INVALID_ARGUMENT"
);

let recoveredSubscriptions = 0;
const recovering = createNuriteoWebContainer({
  services: new NuriteoServices({
    preview: {
      async listPorts() { return []; },
      subscribe() {
        recoveredSubscriptions += 1;
        if (recoveredSubscriptions === 1) throw new Error("temporary subscribe failure");
        return () => {};
      }
    }
  })
});
await assert.rejects(
  () => recovering.boot(),
  (error) => error instanceof SdkError && error.code === "ESDK_LIFECYCLE_FAILED" && error.cause instanceof Error
);
assert.equal(recoveredSubscriptions, 1);
await recovering.boot();
await recovering.teardown();
assert.equal(recoveredSubscriptions, 2);

const assets = resolveNuriteoWorkerAssets("https://cdn.example/sdk/");
assert.equal(assets.systemWorkerUrl.href, "https://cdn.example/sdk/workers/system-worker.ts");
assert.equal(assets.processWorkerUrl.href, "https://cdn.example/sdk/workers/process-worker.ts");
assert.equal(assets.systemWasmUrl.href, "https://cdn.example/sdk/assets/system_wasm.wasm");

const registration = { scope: "/preview/" };
assert.equal(await registerNuriteoPreviewServiceWorker({
  scriptUrl: "/preview-sw.js",
  scope: "/preview/",
  navigator: {
    serviceWorker: {
      async register(script, options) {
        assert.equal(script, "/preview-sw.js");
        assert.deepEqual(options, { scope: "/preview/" });
        return registration;
      }
    }
  }
}), registration);

const missing = new NuriteoServices();
await assert.rejects(() => missing.fs.readFile("/x"), (error) => error instanceof SdkError && error.code === "ESDK_ADAPTER_MISSING");
await assert.rejects(() => missing.packages.run(""), (error) => error instanceof SdkError && error.code === "ESDK_ADAPTER_MISSING");

function result(command) {
  return { command, exitCode: 0, stdout: "ok", stderr: "" };
}

console.log("sdk services test ok");
