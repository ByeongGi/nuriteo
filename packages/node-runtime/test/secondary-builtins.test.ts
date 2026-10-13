import assert from "node:assert/strict";

import {
  BrowserProcess,
  createBuiltinLoader,
  processBuiltin
} from "../../node-runtime/src/index.ts";
import { runUnsafeCommonJsForLocalTests } from "../../node-runtime/src/bootstrap.ts";

function exercisePortableBuiltins({ path, url, assertModule }) {
  assert.equal(path.posix.join("/workspace", "src", "..", "package.json"), "/workspace/package.json");
  assert.equal(path.posix.normalize("/a//b/../c/"), "/a/c/");
  assert.equal(path.posix.relative("/workspace/src", "/workspace/package.json"), "../package.json");
  assert.equal(path.posix.dirname("/workspace/src/main.ts"), "/workspace/src");
  assert.equal(path.posix.basename("/workspace/src/main.ts", ".ts"), "main");
  assert.equal(path.posix.extname("/workspace/src/main.ts"), ".ts");
  assert.equal(path.posix.isAbsolute("/workspace"), true);
  assert.deepEqual(path.posix.parse("/workspace/src/main.ts"), {
    root: "/",
    dir: "/workspace/src",
    base: "main.ts",
    ext: ".ts",
    name: "main"
  });

  const fileUrl = url.pathToFileURL("/workspace/hello world.txt");
  assert.equal(fileUrl.href, "file:///workspace/hello%20world.txt");
  assert.equal(url.fileURLToPath(fileUrl), "/workspace/hello world.txt");
  const httpOptions = url.urlToHttpOptions(new URL("https://user:pw@example.test:8443/a?b=1#c"));
  assert.deepEqual({ ...httpOptions }, {
    protocol: "https:",
    hostname: "example.test",
    hash: "#c",
    search: "?b=1",
    pathname: "/a",
    path: "/a?b=1",
    href: "https://user:pw@example.test:8443/a?b=1#c",
    port: 8443,
    auth: "user:pw"
  });
  assertModule.ok(true);
  assertModule.equal("1", 1);
  assertModule.strictEqual(1, 1);
  assertModule.deepStrictEqual({ a: [1] }, { a: [1] });
  assertModule.throws(() => {
    throw new Error("boom");
  }, /boom/);
}

const nodePath = await import("node:path");
const nodeUrl = await import("node:url");
const nodeAssert = await import("node:assert");
exercisePortableBuiltins({
  path: nodePath,
  url: nodeUrl,
  assertModule: nodeAssert
});

const requireBuiltin = createBuiltinLoader({});
const runtimePath = requireBuiltin("node:path");
const runtimeUrl = requireBuiltin("node:url");
const runtimeAssert = requireBuiltin("node:assert");
exercisePortableBuiltins({
  path: runtimePath,
  url: runtimeUrl,
  assertModule: runtimeAssert
});
const parsedUrl = runtimeUrl.parse("https://user:pw@example.test:8443/a?b=1#c", true);
assert.equal(parsedUrl.protocol, "https:");
assert.equal(parsedUrl.host, "example.test:8443");
assert.equal(parsedUrl.auth, "user:pw");
assert.deepEqual({ ...parsedUrl.query }, { b: "1" });
assert.equal(runtimeUrl.format(parsedUrl), "https://user:pw@example.test:8443/a?b=1#c");
assert.equal(runtimeUrl.resolve("https://example.test/a/b", "../c"), "https://example.test/c");
assert.equal(runtimeUrl.resolve("//registry.npmjs.org/", "."), "//registry.npmjs.org/");

const os = requireBuiltin("os");
assert.equal(os.platform(), "linux");
assert.equal(os.arch(), "x64");
assert.equal(os.tmpdir(), "/tmp");
assert.equal(os.homedir(), "/home/webcontainer");
assert.equal(os.EOL, "\n");
assert.equal(os.version(), "browser");
assert.deepEqual(os.networkInterfaces(), {});
assert.equal(os.constants.errno.EEXIST, 17);
assert.equal(os.constants.signals.SIGTERM, 15);
assert.equal(os.cpus().length, 1);

const tty = requireBuiltin("node:tty");
assert.equal(tty.isatty(1), false);
assert.equal(new tty.WriteStream().isTTY, false);

const v8 = requireBuiltin("node:v8");
assert.equal(typeof v8.getHeapStatistics().heap_size_limit, "number");
assert.deepEqual(v8.getHeapSpaceStatistics(), []);

const vm = requireBuiltin("node:vm");
const vmContext = vm.createContext({ value: 2 });
assert.equal(vm.isContext(vmContext), true);
assert.equal(vm.runInContext("value += 3; value", vmContext), 5);
assert.equal(vmContext.value, 5);
const manifestContext = {};
vm.runInNewContext("this.__BUILD_MANIFEST = { routes: ['/'] }", manifestContext);
assert.deepEqual(manifestContext.__BUILD_MANIFEST, { routes: ["/"] });
vm.runInNewContext("globalThis.__RSC_MANIFEST = { '/page': { clientModules: {} } }", manifestContext);
assert.deepEqual(manifestContext.__RSC_MANIFEST, { "/page": { clientModules: {} } });
assert.equal(new vm.Script("value * 2").runInContext(vmContext), 10);
vm.runInContext("function add(left, right) { return left + right }", vmContext);
assert.equal(vmContext.add(2, 3), 5);
vm.runInContext("runtimeEntries = { page: true }", vmContext);
assert.deepEqual(vmContext.runtimeEntries, { page: true });

const stream = requireBuiltin("node:stream");
const transformed = stream.pipeline(
  stream.Readable.from([new TextEncoder().encode("action-body")]),
  new stream.Transform({ transform(chunk, _encoding, callback) { callback(null, chunk); } }),
  () => {}
);
const transformedChunks = [];
for await (const chunk of transformed) transformedChunks.push(chunk);
assert.equal(new TextDecoder().decode(transformedChunks[0]), "action-body");

const zlib = requireBuiltin("node:zlib");
assert.equal(typeof zlib.Deflate, "function");
assert.equal(typeof zlib.createDeflate, "function");
assert.equal(zlib.constants.Z_BEST_SPEED, 1);
const deflated = zlib.createDeflate()._handle._processChunk(new TextEncoder().encode("deflate-ok"))[0];
assert.equal(new TextDecoder().decode(zlib.createInflate()._handle._processChunk(deflated)[0]), "deflate-ok");
const compressed = zlib.gzipSync(new TextEncoder().encode("zip-ok"));
const unzip = zlib.createUnzip();
assert.equal(typeof unzip._handle._processChunk, "function");
assert.equal(new TextDecoder().decode(unzip._handle._processChunk(compressed)[0]), "zip-ok");
assert.equal(new TextDecoder().decode(zlib.gunzipSync(compressed)), "zip-ok");
assert.equal(unzip.reset(), undefined);
assert.equal(unzip.close(), undefined);

const moduleBuiltin = requireBuiltin("node:module");
assert.equal(moduleBuiltin.enableCompileCache().status, 0);
assert.equal(moduleBuiltin.builtinModules.includes("node:module"), true);
assert.equal(moduleBuiltin.builtinModules.includes("node:async_hooks"), true);
assert.equal(moduleBuiltin.builtinModules.includes("node:querystring"), true);
assert.equal(moduleBuiltin.builtinModules.includes("node:string_decoder"), true);
assert.equal(moduleBuiltin.builtinModules.includes("node:timers/promises"), true);
assert.equal(moduleBuiltin.builtinModules.includes("node:perf_hooks"), true);
assert.equal(moduleBuiltin.builtinModules.includes("node:wasi"), true);
assert.equal(moduleBuiltin.isBuiltin("node:module"), true);
assert.equal(moduleBuiltin.isBuiltin("module"), true);
assert.equal(moduleBuiltin.isBuiltin("vite"), false);
assert.equal(moduleBuiltin.syncBuiltinESMExports(), undefined);
assert.deepEqual(moduleBuiltin.Module._nodeModulePaths("/workspace/app"), [
  "/workspace/app/node_modules",
  "/workspace/node_modules",
  "/node_modules"
]);
assert.deepEqual(moduleBuiltin._nodeModulePaths("/workspace/app"), moduleBuiltin.Module._nodeModulePaths("/workspace/app"));
assert.equal(moduleBuiltin.Module._resolveFilename("node:path"), "node:path");

const processModule = requireBuiltin("process");
assert.equal(processModule.version, "v22.23.0");
assert.equal(processModule.features.typescript, false);
assert.equal(processModule.features.require_module, true);
assert.equal(processModule.execPath, "/usr/local/bin/node");
assert.equal(processModule.cwd(), "/workspace");
assert.deepEqual(processModule.execArgv, []);
let stdinEvent = "";
processModule.stdin.on("data", (chunk) => {
  stdinEvent = String(chunk);
});
processModule.stdin.emit("data", "typed");
assert.equal(stdinEvent, "typed");
assert.equal(processModule.stdin.setRawMode(true), processModule.stdin);
assert.equal(processModule.stdin.pause(), processModule.stdin);
assert.equal(processModule.stdin.resume(), processModule.stdin);
let stdoutFlushed = false;
assert.equal(processModule.stdout.write("", () => { stdoutFlushed = true; }), true);
assert.equal(stdoutFlushed, true);
let stderrFlushed = false;
assert.equal(processModule.stderr.write("", "utf8", () => { stderrFlushed = true; }), true);
assert.equal(stderrFlushed, true);
processModule.chdir("app");
assert.equal(processModule.cwd(), "/workspace/app");
assert.equal(processModule.umask(), 0o022);
assert.equal(processModule.umask(0o077), 0o022);
assert.equal(processModule.umask(), 0o077);
const startedAt = processModule.hrtime();
const elapsed = processModule.hrtime(startedAt);
assert.equal(startedAt.length, 2);
assert.equal(elapsed.length, 2);
assert.equal(typeof elapsed[0], "number");
assert.equal(typeof elapsed[1], "number");
await new Promise((resolve) => processModule.nextTick(resolve));
assert.equal(processBuiltin.platform, "linux");
assert.equal(Object.hasOwn(new BrowserProcess().binding("natives"), "fs"), true);
assert.equal(new BrowserProcess().binding("constants").fs.O_CREAT, 0o100);
assert.throws(() => new BrowserProcess().binding("unsupported"), { code: "ERR_UNKNOWN_BUILTIN_MODULE" });
assert.throws(() => new BrowserProcess().exit(3), /process\.exit\(3\)/);
const capturedProcess = new BrowserProcess({ exitMode: "capture" });
assert.equal(capturedProcess.exit(4), undefined);
assert.equal(capturedProcess.exitCode, 4);
const terminalProcess = new BrowserProcess({
  exitMode: "capture",
  terminal: true,
  terminalSize: { cols: 100, rows: 30 },
  writeStdout: () => false
});
const terminalInput = [];
terminalProcess.stdin.on("data", (chunk) => terminalInput.push(chunk));
assert.equal(terminalProcess.stdin.isTTY, true);
assert.equal(terminalProcess.stdout.columns, 100);
assert.equal(terminalProcess.writeStdin("hello\n"), true);
assert.deepEqual(terminalInput, ["hello\n"]);
assert.equal(terminalProcess.stdout.write("backpressure"), false);
let drained = false;
terminalProcess.stdout.once("drain", () => { drained = true; });
terminalProcess.notifyDrain("stdout");
assert.equal(drained, true);
let resized = false;
terminalProcess.once("SIGWINCH", () => { resized = true; });
terminalProcess.resizeTerminal(120, 40);
assert.equal(resized, true);
assert.equal(terminalProcess.stdout.rows, 40);
terminalProcess.signal("SIGTERM");
assert.equal(terminalProcess.exitCode, 143);

const events = requireBuiltin("node:events");
const emitter = new events.EventEmitter();
const listenerOrder = [];
const newListenerEvents = [];
emitter.on("newListener", (eventName) => {
  newListenerEvents.push(eventName);
});
emitter.on("ready", () => listenerOrder.push("on"));
emitter.prependListener("ready", () => listenerOrder.push("prepend"));
emitter.prependOnceListener("ready", () => listenerOrder.push("prepend-once"));
assert.deepEqual(newListenerEvents, ["ready", "ready", "ready"]);
emitter.emit("ready");
emitter.emit("ready");
assert.deepEqual(listenerOrder, ["prepend-once", "prepend", "on", "prepend", "on"]);

const constants = requireBuiltin("node:constants");
assert.equal(constants.EEXIST, 17);
assert.equal(constants.O_RDONLY, 0);
assert.equal(constants.O_CREAT, 0o100);
assert.equal(constants.O_TRUNC, 0o1000);
assert.equal(constants.S_IFDIR, 0o040000);

const crypto = requireBuiltin("node:crypto");
assert.equal(crypto.createHash("sha1").update("abc").digest("hex"), "a9993e364706816aba3e25717850c26c9cd0d89d");
assert.equal(crypto.createHash("sha256").update("abc").digest("hex"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
assert.equal(crypto.createHash("sha512").update("abc").digest("base64"), "3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==");
assert.equal(crypto.hash("sha256", "abc", "hex"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
assert.equal(crypto.getHashes().includes("sha512"), true);
assert.equal(crypto.randomBytes(8).byteLength, 8);
const randomValues = new Uint8Array(8);
assert.equal(crypto.getRandomValues(randomValues), randomValues);
assert.equal(randomValues.byteLength, 8);
const webRandomValues = new Uint8Array(4);
assert.equal(crypto.webcrypto.getRandomValues(webRandomValues), webRandomValues);
assert.equal(crypto.randomUUID().length, 36);
assert.equal(crypto.timingSafeEqual(Buffer.from("aa"), Buffer.from("aa")), true);
assert.throws(() => crypto.createPublicKey(""), /does not support createPublicKey/);

const dns = requireBuiltin("dns");
const dnsLookup = await new Promise((resolve, reject) => {
  dns.lookup("localhost", (error, address, family) => {
    if (error) reject(error);
    else resolve({ address, family });
  });
});
assert.deepEqual(dnsLookup, { address: "127.0.0.1", family: 4 });
assert.deepEqual(await dns.promises.lookup("localhost"), { address: "127.0.0.1", family: 4 });
assert.equal(await requireBuiltin("node:dns/promises").lookup("example.test", { family: 4 }), "0.0.0.0");

const querystring = requireBuiltin("querystring");
assert.deepEqual({ ...querystring.parse("name=nuriteo+runtime&tag=web&tag=runtime") }, {
  name: "nuriteo runtime",
  tag: ["web", "runtime"]
});
assert.equal(querystring.stringify({ name: "nuriteo runtime", tag: ["web", "runtime"] }), "name=nuriteo%20runtime&tag=web&tag=runtime");

const { StringDecoder } = requireBuiltin("node:string_decoder");
const decoder = new StringDecoder("utf8");
const encoded = new TextEncoder().encode("안녕");
assert.equal(decoder.write(encoded.slice(0, 2)), "");
assert.equal(decoder.end(encoded.slice(2)), "안녕");

const timers = requireBuiltin("node:timers/promises");
assert.equal(await timers.setTimeout(1, "done"), "done");
assert.equal(typeof requireBuiltin("timers").setTimeout, "function");
assert.equal(requireBuiltin("node:timers").clearTimeout, clearTimeout);

const asyncHooks = requireBuiltin("node:async_hooks");
const asyncLocalStorage = new asyncHooks.AsyncLocalStorage();
assert.equal(asyncLocalStorage.getStore(), undefined);
assert.equal(asyncLocalStorage.run({ requestId: "vite" }, () => asyncLocalStorage.getStore().requestId), "vite");
assert.equal(asyncLocalStorage.getStore(), undefined);
asyncLocalStorage.enterWith("pnpm");
assert.equal(asyncLocalStorage.getStore(), "pnpm");
assert.equal(asyncLocalStorage.exit(() => asyncLocalStorage.getStore()), undefined);
assert.equal(asyncLocalStorage.getStore(), "pnpm");
asyncLocalStorage.disable();
assert.equal(asyncLocalStorage.getStore(), undefined);
const asyncHook = asyncHooks.createHook({ init() {} });
assert.equal(asyncHook.enable(), asyncHook);
assert.equal(asyncHook.disable(), asyncHook);
assert.equal(asyncHooks.executionAsyncId(), 0);
assert.equal(asyncHooks.triggerAsyncId(), 0);

const wasi = requireBuiltin("node:wasi");
const runtimeWasi = new wasi.WASI({
  env: { NODE_ENV: "test" },
  preopens: { "/": "/" },
  returnOnExit: true,
  version: "preview1"
});
assert.equal(runtimeWasi.version, "preview1");
assert.equal(runtimeWasi.getImportObject().wasi_snapshot_preview1, runtimeWasi.wasiImport);
assert.equal(typeof runtimeWasi.wasiImport.random_get, "function");
const wasiMemory = new WebAssembly.Memory({ initial: 1 });
runtimeWasi.initialize({ exports: { memory: wasiMemory } });
assert.equal(runtimeWasi.wasiImport.random_get(0, 8), 0);
assert.equal(new Uint8Array(wasiMemory.buffer, 0, 8).some((value) => value !== 0), true);
assert.equal(runtimeWasi.start({ exports: { memory: wasiMemory } }), 0);

const wasiOutput = [];
const wasiInput = [new TextEncoder().encode("terminal input")];
const terminalWasi = new wasi.WASI({
  returnOnExit: true,
  stdio: {
    read: () => wasiInput.shift() ?? null,
    write: (stream, data) => {
      wasiOutput.push([stream, new TextDecoder().decode(data)]);
    }
  }
});
terminalWasi.initialize({ exports: { memory: wasiMemory } });
const wasiView = new DataView(wasiMemory.buffer);
const wasiHeap = new Uint8Array(wasiMemory.buffer);
wasiView.setUint32(64, 128, true);
wasiView.setUint32(68, 8, true);
wasiView.setUint32(72, 136, true);
wasiView.setUint32(76, 8, true);
assert.equal(terminalWasi.wasiImport.fd_read(0, 64, 2, 32), 0);
assert.equal(wasiView.getUint32(32, true), 14);
assert.equal(new TextDecoder().decode(wasiHeap.subarray(128, 142)), "terminal input");
const encodedOutput = new TextEncoder().encode("WASI output\n");
wasiHeap.set(encodedOutput, 160);
wasiView.setUint32(80, 160, true);
wasiView.setUint32(84, encodedOutput.byteLength, true);
assert.equal(terminalWasi.wasiImport.fd_write(1, 80, 1, 36), 0);
assert.equal(wasiView.getUint32(36, true), encodedOutput.byteLength);
assert.deepEqual(wasiOutput, [["stdout", "WASI output\n"]]);

const perfHooks = requireBuiltin("node:perf_hooks");
const mark = perfHooks.performance.mark("vite-start");
assert.equal(mark.entryType, "mark");
assert.equal(mark.name, "vite-start");
assert.equal(typeof perfHooks.performance.now(), "number");
const measure = perfHooks.performance.measure("vite-bootstrap", "vite-start");
assert.equal(measure.entryType, "measure");
assert.equal(perfHooks.performance.getEntriesByType("mark").some((entry) => entry.name === "vite-start"), true);
assert.equal(perfHooks.performance.getEntriesByName("vite-bootstrap")[0].duration >= 0, true);
let observed = false;
const observer = new perfHooks.PerformanceObserver(() => {
  observed = true;
});
observer.observe({ entryTypes: ["mark", "measure"] });
assert.equal(observed, true);
assert.deepEqual(observer.takeRecords(), []);
assert.equal(perfHooks.constants.NODE_PERFORMANCE_ENTRY_TYPE_MARK, "mark");
perfHooks.performance.clearMarks("vite-start");
assert.equal(perfHooks.performance.getEntriesByName("vite-start").length, 0);

const readline = requireBuiltin("node:readline");
readline.emitKeypressEvents({ on() {} });
const rl = readline.createInterface({ input: ["one\ntwo", "\nthree"], terminal: false });
const lines = [];
for await (const line of rl) lines.push(line);
assert.deepEqual(lines, ["one", "two", "three"]);
let closed = false;
rl.on("close", () => {
  closed = true;
});
rl.close();
assert.equal(closed, true);

const files = new Map();
const links = new Map();
const openFilePaths = new Map();
const metadataCalls = [];
const fsPromises = createBuiltinLoader({
  fs: {
    chmodSync(path, mode) {
      metadataCalls.push(["chmod", path, mode]);
    },
    chownSync(path, uid, gid) {
      metadataCalls.push(["chown", path, uid, gid]);
    },
    closeSync() {},
    fchmodSync(fd, mode) {
      metadataCalls.push(["fchmod", fd, mode]);
    },
    fchownSync(fd, uid, gid) {
      metadataCalls.push(["fchown", fd, uid, gid]);
    },
    fsyncSync(fd) {
      metadataCalls.push(["fsync", fd]);
    },
    mkdirSync(path) {
      files.set(path, new Uint8Array());
    },
    openSync(path) {
      openFilePaths.set(1, path);
      return 1;
    },
    readFileSync(path, encoding) {
      const bytes = files.get(path) || new Uint8Array();
      return encoding ? new TextDecoder().decode(bytes) : bytes;
    },
    readlinkSync(path) {
      return links.get(path);
    },
    readdirSync(path) {
      const prefix = `${path}/`;
      return [...files.keys()]
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => entry.slice(prefix.length).split("/")[0])
        .filter((entry, index, entries) => entry && entries.indexOf(entry) === index);
    },
    readSync(fd) {
      return files.get(openFilePaths.get(fd)) || new Uint8Array();
    },
    copyFileSync(source, target) {
      files.set(target, files.get(source));
    },
    linkSync(source, target) {
      files.set(target, files.get(source));
    },
    lchmodSync(path, mode) {
      metadataCalls.push(["lchmod", path, mode]);
    },
    lchownSync(path, uid, gid) {
      metadataCalls.push(["lchown", path, uid, gid]);
    },
    renameSync(source, target) {
      files.set(target, files.get(source));
      files.delete(source);
    },
    rmSync(path) {
      files.delete(path);
    },
    statSync(path) {
      const bytes = files.get(path);
      return {
        size: bytes?.byteLength ?? 0,
        isFile: () => files.has(path),
        isDirectory: () => false
      };
    },
    symlinkSync(target, path) {
      links.set(path, target);
    },
    writeFileSync(path, data) {
      files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data));
    },
    writeSync() {
      return 0;
    }
  }
})("node:fs/promises");
await fsPromises.writeFile("/workspace/fs-promises.txt", "hello");
assert.equal(await fsPromises.readFile("/workspace/fs-promises.txt", "utf8"), "hello");
assert.equal((await fsPromises.stat("/workspace/fs-promises.txt")).size, 5);
assert.deepEqual(await fsPromises.readdir("/workspace"), ["fs-promises.txt"]);
const tempDir = await fsPromises.mkdtemp("/workspace/tmp-");
assert.equal(tempDir.startsWith("/workspace/tmp-"), true);
await fsPromises.copyFile("/workspace/fs-promises.txt", "/workspace/fs-promises-copy.txt");
assert.equal(await fsPromises.readFile("/workspace/fs-promises-copy.txt", "utf8"), "hello");
await fsPromises.link("/workspace/fs-promises-copy.txt", "/workspace/fs-promises-link.txt");
assert.equal(await fsPromises.readFile("/workspace/fs-promises-link.txt", "utf8"), "hello");
await fsPromises.utimes("/workspace/fs-promises.txt", new Date(), new Date());
await fsPromises.chmod("/workspace/fs-promises.txt", 0o755);
await fsPromises.chown("/workspace/fs-promises.txt", 0, 0);
await fsPromises.lchmod("/workspace/fs-promises.txt", 0o755);
await fsPromises.lchown("/workspace/fs-promises.txt", 0, 0);
await fsPromises.fchmod(1, 0o644);
await fsPromises.fchown(1, 0, 0);
await fsPromises.fsync(1);
const handle = await fsPromises.open("/workspace/fs-promises.txt", "r+");
const handleBuffer = new Uint8Array(2);
assert.deepEqual(await handle.read(handleBuffer, 0, 2, 1), { bytesRead: 2, buffer: new Uint8Array([101, 108]) });
await handle.chmod(0o755);
await handle.chown(0, 0);
await handle.sync();
await handle.write("!");
await handle.close();
assert.deepEqual(metadataCalls, [
  ["chmod", "/workspace/fs-promises.txt", 0o755],
  ["chown", "/workspace/fs-promises.txt", 0, 0],
  ["lchmod", "/workspace/fs-promises.txt", 0o755],
  ["lchown", "/workspace/fs-promises.txt", 0, 0],
  ["fchmod", 1, 0o644],
  ["fchown", 1, 0, 0],
  ["fsync", 1],
  ["fchmod", 1, 0o755],
  ["fchown", 1, 0, 0],
  ["fsync", 1]
]);
await fsPromises.rename("/workspace/fs-promises.txt", "/workspace/fs-promises-renamed.txt");
assert.equal(await fsPromises.readFile("/workspace/fs-promises-renamed.txt", "utf8"), "hello");
await fsPromises.unlink("/workspace/fs-promises.txt");
assert.equal(files.has("/workspace/fs-promises.txt"), false);
await fsPromises.rm("/workspace/missing.txt", { force: true });
await fsPromises.symlink("/workspace/target", "/workspace/link", "dir");
assert.equal(links.get("/workspace/link"), "/workspace/target");
assert.equal(await fsPromises.readlink("/workspace/link"), "/workspace/target");

const fetchCalls = [];
const httpRequire = createBuiltinLoader({
  httpClient: {
    async download(input, options = {}) {
      fetchCalls.push({ input: String(input), method: options.method, body: new TextDecoder().decode(options.body) });
      return {
        body: new TextEncoder().encode("response-body"),
        headers: { "content-type": "text/plain" },
        ok: true,
        redirected: false,
        redirects: [],
        sha256: "",
        status: 201,
        url: String(input)
      };
    }
  }
});
const http = httpRequire("http");
assert.equal(http.STATUS_CODES[200], "OK");
const httpServer = http.createServer((request, response) => {
  response.writeHead(204, { "x-runtime": "browser" });
  assert.equal(request.url, "/");
});
let listening = false;
await new Promise((resolve) => {
  httpServer.listen(5173, "127.0.0.1", () => {
    listening = true;
    resolve();
  });
});
assert.equal(listening, true);
assert.deepEqual(httpServer.address(), { address: "127.0.0.1", family: "IPv4", port: 5173 });
assert.equal(httpServer.setTimeout(1000), httpServer);
assert.equal(httpServer.timeout, 1000);
await new Promise((resolve) => httpServer.close(resolve));
assert.equal(httpServer.address(), null);
const abortedRequest = http.request("http://registry.test/abort");
let abortEvent = false;
abortedRequest.on("abort", () => {
  abortEvent = true;
});
assert.equal(abortedRequest.abort(), abortedRequest);
assert.equal(abortEvent, true);
const httpResponse = await new Promise((resolve, reject) => {
  const request = http.request({ hostname: "registry.test", path: "/pkg", method: "POST" }, (response) => {
    const chunks = [];
    assert.deepEqual(response.rawHeaders, ["content-type", "text/plain"]);
    assert.deepEqual(response.trailers, {});
    assert.deepEqual(response.rawTrailers, []);
    response.on("data", (chunk) => chunks.push(new TextDecoder().decode(chunk)));
    response.on("end", () => resolve({ statusCode: response.statusCode, body: chunks.join("") }));
  });
  request.on("error", reject);
  request.end("request-body");
});
assert.deepEqual(httpResponse, { statusCode: 201, body: "response-body" });
assert.deepEqual(fetchCalls, [{ input: "http://registry.test/pkg", method: "POST", body: "request-body" }]);

const http2 = requireBuiltin("node:http2");
assert.equal(http2.constants.HTTP2_HEADER_PATH, ":path");
assert.equal(http2.constants.HTTP_STATUS_TOO_MANY_REQUESTS, 429);
const http2Session = http2.connect("https://registry.test");
const http2Error = await new Promise((resolve) => http2Session.once("error", resolve));
assert.equal(http2Error.code, "ERR_BROWSER_HTTP2_UNSUPPORTED");

const net = requireBuiltin("node:net");
assert.equal(net.isIP("127.0.0.1"), 4);
assert.equal(net.isIPv6("::1"), true);
const socket = net.createConnection({ host: "database.local", port: 5432 });
const tcpError = await new Promise((resolve) => socket.once("error", resolve));
assert.equal(tcpError.code, "ERR_BROWSER_TCP_UNSUPPORTED");

const tls = requireBuiltin("tls");
assert.equal(Array.isArray(tls.rootCertificates), true);
const tlsSocket = tls.connect({ host: "registry.test", port: 443 });
const tlsError = await new Promise((resolve) => tlsSocket.once("error", resolve));
assert.equal(tlsError.code, "ERR_BROWSER_TCP_UNSUPPORTED");

const childProcess = requireBuiltin("node:child_process");
const child = childProcess.spawn("python", ["--version"]);
const childError = await new Promise((resolve) => child.once("error", resolve));
assert.equal(childError.code, "ERR_BROWSER_CHILD_PROCESS_UNSUPPORTED");
assert.equal(childProcess.spawnSync("python").status, 1);
assert.throws(() => childProcess.execSync("python --version"), /External child process execution/);

const workerThreads = requireBuiltin("node:worker_threads");
assert.equal(workerThreads.isMainThread, true);
assert.equal(workerThreads.threadId, 0);
assert.equal(workerThreads.parentPort, null);
const channel = new workerThreads.MessageChannel();
const channelMessage = new Promise((resolve) => channel.port2.once("message", resolve));
channel.port1.postMessage({ ok: true });
assert.deepEqual(await channelMessage, { ok: true });
const worker = new workerThreads.Worker("/workspace/worker.js", { workerData: { task: "build" } });
assert.deepEqual(worker.workerData, { task: "build" });
const workerError = await new Promise((resolve) => worker.once("error", resolve));
assert.equal(workerError.code, "ERR_BROWSER_WORKER_THREAD_UNSUPPORTED");

const result = runUnsafeCommonJsForLocalTests(`
  const assert = require("node:assert/strict");
  const childProcess = require("child_process");
  const crypto = require("node:crypto");
  const dns = require("node:dns");
  const http = require("http");
  const http2 = require("http2");
  const net = require("net");
  const path = require("path");
  const workerThreads = require("worker_threads");
  const os = require("node:os");
  const qs = require("node:querystring");
  const { Buffer } = require("buffer");
  const { StringDecoder } = require("string_decoder");
  const readline = require("readline");
  const v8 = require("node:v8");
  const { fileURLToPath, pathToFileURL } = require("url");
  const process = require("process");
  assert.equal(typeof childProcess.spawn, "function");
  assert.equal(crypto.createHash("sha256").update("runtime").digest("hex").length, 64);
  assert.equal(crypto.randomBytes(4).length, 4);
  assert.equal(path.join("/workspace", "src", "..", "index.js"), "/workspace/index.js");
  assert.equal(fileURLToPath(pathToFileURL("/workspace/a b.js")), "/workspace/a b.js");
  assert.equal(os.platform(), "linux");
  assert.equal(typeof dns.lookup, "function");
  assert.equal(typeof http.request, "function");
  assert.equal(http2.constants.HTTP2_HEADER_METHOD, ":method");
  assert.equal(net.isIP("127.0.0.1"), 4);
  assert.equal(workerThreads.threadId, 0);
  assert.equal(workerThreads.isMainThread, true);
  assert.equal(qs.parse("a=1&a=2").a.length, 2);
  assert.equal(new StringDecoder().end(Buffer.from("ok")), "ok");
  assert.equal(typeof v8.getHeapStatistics().heap_size_limit, "number");
  assert.equal(typeof process.pid, "number");
  assert.deepEqual(process.execArgv, []);
  assert.equal(process.report.excludeNetwork, false);
  process.report.excludeNetwork = true;
  assert.equal(process.report.getReport().header.platform, "linux");
  readline.emitKeypressEvents({ on() {} });
  module.exports = {
    cwd: process.cwd(),
    path: path.basename("/workspace/index.js"),
    tty: require("tty").isatty(1)
  };
`, { syncChannel: new SharedArrayBuffer(1024 * 1024 + 4096) });

assert.deepEqual(result.exports, {
  cwd: "/workspace",
  path: "index.js",
  tty: false
});

console.log("node secondary builtins test ok");
