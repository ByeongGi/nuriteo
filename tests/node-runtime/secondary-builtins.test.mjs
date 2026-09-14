import assert from "node:assert/strict";

import {
  BrowserProcess,
  createBuiltinLoader,
  processBuiltin
} from "../../packages/node-runtime/src/index.ts";
import { runUnsafeCommonJsForLocalTests } from "../../packages/node-runtime/src/bootstrap.ts";

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

const os = requireBuiltin("os");
assert.equal(os.platform(), "linux");
assert.equal(os.arch(), "x64");
assert.equal(os.tmpdir(), "/tmp");
assert.equal(os.homedir(), "/home/webcontainer");
assert.equal(os.EOL, "\n");
assert.equal(os.version(), "browser");
assert.equal(os.constants.signals.SIGTERM, 15);
assert.equal(os.cpus().length, 1);

const tty = requireBuiltin("node:tty");
assert.equal(tty.isatty(1), false);
assert.equal(new tty.WriteStream().isTTY, false);

const v8 = requireBuiltin("node:v8");
assert.equal(typeof v8.getHeapStatistics().heap_size_limit, "number");
assert.deepEqual(v8.getHeapSpaceStatistics(), []);

const moduleBuiltin = requireBuiltin("node:module");
assert.equal(moduleBuiltin.enableCompileCache().status, 0);
assert.equal(moduleBuiltin.builtinModules.includes("node:module"), true);
assert.equal(moduleBuiltin.builtinModules.includes("node:querystring"), true);
assert.equal(moduleBuiltin.builtinModules.includes("node:string_decoder"), true);
assert.equal(moduleBuiltin.builtinModules.includes("node:timers/promises"), true);
assert.deepEqual(moduleBuiltin.Module._nodeModulePaths("/workspace/app"), [
  "/workspace/app/node_modules",
  "/workspace/node_modules",
  "/node_modules"
]);
assert.equal(moduleBuiltin.Module._resolveFilename("node:path"), "node:path");

const processModule = requireBuiltin("process");
assert.equal(processModule.version, "v22.23.0");
assert.equal(processModule.execPath, "/usr/local/bin/node");
assert.equal(processModule.cwd(), "/workspace");
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
await new Promise((resolve) => processModule.nextTick(resolve));
assert.equal(processBuiltin.platform, "linux");
assert.throws(() => new BrowserProcess().exit(3), /process\.exit\(3\)/);
const capturedProcess = new BrowserProcess({ exitMode: "capture" });
assert.equal(capturedProcess.exit(4), undefined);
assert.equal(capturedProcess.exitCode, 4);

const constants = requireBuiltin("node:constants");
assert.equal(constants.O_RDONLY, 0);
assert.equal(constants.O_CREAT, 0o100);
assert.equal(constants.O_TRUNC, 0o1000);
assert.equal(constants.S_IFDIR, 0o040000);

const crypto = requireBuiltin("node:crypto");
assert.equal(crypto.createHash("sha1").update("abc").digest("hex"), "a9993e364706816aba3e25717850c26c9cd0d89d");
assert.equal(crypto.createHash("sha256").update("abc").digest("hex"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
assert.equal(crypto.createHash("sha512").update("abc").digest("base64"), "3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==");
assert.equal(crypto.getHashes().includes("sha512"), true);
assert.equal(crypto.randomBytes(8).byteLength, 8);
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
assert.deepEqual({ ...querystring.parse("name=cargo+container&tag=web&tag=runtime") }, {
  name: "cargo container",
  tag: ["web", "runtime"]
});
assert.equal(querystring.stringify({ name: "cargo container", tag: ["web", "runtime"] }), "name=cargo%20container&tag=web&tag=runtime");

const { StringDecoder } = requireBuiltin("node:string_decoder");
const decoder = new StringDecoder("utf8");
const encoded = new TextEncoder().encode("안녕");
assert.equal(decoder.write(encoded.slice(0, 2)), "");
assert.equal(decoder.end(encoded.slice(2)), "안녕");

const timers = requireBuiltin("node:timers/promises");
assert.equal(await timers.setTimeout(1, "done"), "done");
assert.equal(typeof requireBuiltin("timers").setTimeout, "function");
assert.equal(requireBuiltin("node:timers").clearTimeout, clearTimeout);

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
const fsPromises = createBuiltinLoader({
  fs: {
    closeSync() {},
    mkdirSync(path) {
      files.set(path, new Uint8Array());
    },
    openSync() {
      return 1;
    },
    readFileSync(path, encoding) {
      const bytes = files.get(path) || new Uint8Array();
      return encoding ? new TextDecoder().decode(bytes) : bytes;
    },
    readSync() {
      return new Uint8Array();
    },
    statSync(path) {
      const bytes = files.get(path);
      return {
        size: bytes?.byteLength ?? 0,
        isFile: () => files.has(path),
        isDirectory: () => false
      };
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
const httpResponse = await new Promise((resolve, reject) => {
  const request = http.request({ hostname: "registry.test", path: "/pkg", method: "POST" }, (response) => {
    const chunks = [];
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
