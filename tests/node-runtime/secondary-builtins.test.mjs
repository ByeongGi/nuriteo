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

const processModule = requireBuiltin("process");
assert.equal(processModule.cwd(), "/workspace");
processModule.chdir("app");
assert.equal(processModule.cwd(), "/workspace/app");
await new Promise((resolve) => processModule.nextTick(resolve));
assert.equal(processBuiltin.platform, "linux");

const result = runUnsafeCommonJsForLocalTests(`
  const assert = require("node:assert/strict");
  const path = require("path");
  const os = require("node:os");
  const { fileURLToPath, pathToFileURL } = require("url");
  const process = require("process");
  assert.equal(path.join("/workspace", "src", "..", "index.js"), "/workspace/index.js");
  assert.equal(fileURLToPath(pathToFileURL("/workspace/a b.js")), "/workspace/a b.js");
  assert.equal(os.platform(), "linux");
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
