import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const gate = JSON.parse(fs.readFileSync(path.join(root, "compat/yarn-v1-product-support.json"), "utf8"));
const source = fs.readFileSync(path.join(root, gate.artifact.bundle), "utf8");
const digest = crypto.createHash("sha256").update(source).digest("hex");
assert.equal(digest, gate.artifact.bundleSha256, "Vendored Yarn CLI changed; do not regenerate without updating its integrity gate");
const thenifyCall = "return eval(createWrapper($$__fn__$$.name, options))";
assert.equal(source.split(thenifyCall).length - 1, 2, "Expected both pinned thenify wrappers");
const cspSafeSource = source.replaceAll(thenifyCall, () => "return createCspSafeWrapper($$__fn__$$, options)")
  .replace("dns.internalCache = cache;", "if (!Object.isExtensible(dns)) return dns;\n        dns.internalCache = cache;")
  .replace("function createWrapper(name, options) {", `function createCspSafeWrapper(fn, options) {
  options = options || {};
  var multiArgs = options.multiArgs !== undefined ? options.multiArgs : true;
  return function () {
    var self = this;
    var args = Array.prototype.slice.call(arguments);
    if (options.withCallback && typeof args[args.length - 1] === 'function') return fn.apply(self, args);
    return new Promise(function (resolve, reject) {
      args.push(createCallback(resolve, reject, multiArgs));
      fn.apply(self, args);
    });
  };
}

function createWrapper(name, options) {`);
const target = path.join(root, "packages/workspace-runtime/assets/vendor/yarn-cli-1.22.22.mjs");
const output = `// Generated from the integrity-pinned Yarn 1.22.22 bundle. Do not edit by hand.\n` +
  `export const sourceSha256 = ${JSON.stringify(digest)};\n` +
  `export function evaluateYarnCjs(context, globals) {\n` +
  `const { module, require, exports, filename: __filename, dirname: __dirname } = context;\n` +
  `const process = globals.process;\nconst global = globals.global;\nconst globalThis = globals.globalThis;\n` +
  `const console = globals.console;\nconst Buffer = globals.Buffer;\n` +
  `const setTimeout = global.setTimeout;\nconst clearTimeout = global.clearTimeout;\n` +
  `const setInterval = global.setInterval;\nconst clearInterval = global.clearInterval;\n` +
  `const setImmediate = global.setImmediate;\nconst clearImmediate = global.clearImmediate;\n` +
  `${cspSafeSource.startsWith("#!") ? `//${cspSafeSource.slice(2)}` : cspSafeSource}\n}\n`;
assert.equal(crypto.createHash("sha256").update(output).digest("hex"), gate.artifact.cspFactorySha256,
  "Generated factory changed; review the CSP-safe transform and update its pinned hash");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, output);
console.log(`${path.relative(root, target)} sha256=${digest}`);
