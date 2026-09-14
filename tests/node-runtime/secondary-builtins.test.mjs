import assert from "node:assert/strict";

import {
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
assert.equal(os.cpus().length, 1);

const tty = requireBuiltin("node:tty");
assert.equal(tty.isatty(1), false);
assert.equal(new tty.WriteStream().isTTY, false);

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
assert.equal(processModule.cwd(), "/workspace");
processModule.chdir("app");
assert.equal(processModule.cwd(), "/workspace/app");
await new Promise((resolve) => processModule.nextTick(resolve));
assert.equal(processBuiltin.platform, "linux");

const constants = requireBuiltin("node:constants");
assert.equal(constants.O_RDONLY, 0);
assert.equal(constants.S_IFDIR, 0o040000);

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

const result = runUnsafeCommonJsForLocalTests(`
  const assert = require("node:assert/strict");
  const path = require("path");
  const os = require("node:os");
  const qs = require("node:querystring");
  const { Buffer } = require("buffer");
  const { StringDecoder } = require("string_decoder");
  const readline = require("readline");
  const { fileURLToPath, pathToFileURL } = require("url");
  const process = require("process");
  assert.equal(path.join("/workspace", "src", "..", "index.js"), "/workspace/index.js");
  assert.equal(fileURLToPath(pathToFileURL("/workspace/a b.js")), "/workspace/a b.js");
  assert.equal(os.platform(), "linux");
  assert.equal(qs.parse("a=1&a=2").a.length, 2);
  assert.equal(new StringDecoder().end(Buffer.from("ok")), "ok");
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
