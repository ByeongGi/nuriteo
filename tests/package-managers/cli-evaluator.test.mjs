import assert from "node:assert/strict";

import { createAsyncCliModuleEvaluator, createCliModuleEvaluator, createGuestRuntimeProcessRunner, createNpmRunner, MemoryPackageManagerWorkspace } from "../../packages/node-runtime/src/index.ts";

const workspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/cli/package/bin/npm-cli.js",
    data: "#!/usr/bin/env node\nrequire('../lib/cli.js')(process)\n"
  },
  {
    path: "/workspace/cli/package/lib/cli.js",
    data: `
      const fs = require('fs');
      const manifest = require('../package.json');
      module.exports = function run(process) {
        if (process.argv.includes('--version')) {
          process.stdout.write(JSON.parse(fs.readFileSync(__dirname + '/../package.json', 'utf8')).version + '\\n');
          return;
        }
        process.stderr.write('unsupported command\\n');
        process.exit(7);
      };
    `
  },
  {
    path: "/workspace/cli/package/package.json",
    data: JSON.stringify({ name: "fixture-cli", version: "1.2.3", main: "lib/cli.js" })
  },
  {
    path: "/workspace/async-cli/package/bin/npm-cli.js",
    data: "#!/usr/bin/env node\nrequire('../lib/cli.js')(process)\n"
  },
  {
    path: "/workspace/async-cli/package/lib/cli.js",
    data: `
      module.exports = async function run(process) {
        const { Chalk } = await import('chalk');
        const chalk = new Chalk({ level: 0 });
        await Promise.resolve();
        process.stdout.write(chalk('async-version') + '\\n', 'utf8', () => {
          process.exitCode = 0;
        });
      };
    `
  },
  {
    path: "/workspace/async-cli/package/package.json",
    data: JSON.stringify({ name: "async-fixture-cli", version: "1.2.3", main: "lib/cli.js" })
  },
  {
    path: "/workspace/write-cli/package/bin/npm-cli.js",
    data: "#!/usr/bin/env node\nrequire('../lib/cli.js')(process)\n"
  },
  {
    path: "/workspace/write-cli/package/lib/cli.js",
    data: `
      const fs = require('fs');
      module.exports = async function run(process) {
        fs.mkdirSync(process.cwd() + '/.cache');
        fs.writeFileSync(process.cwd() + '/sync.txt', 'sync');
        await fs.promises.writeFile(process.cwd() + '/.cache/async.txt', 'async');
        await fs.promises.lstat(process.cwd() + '/.cache/async.txt');
        fs.writeFileSync(process.cwd() + '/delete-me.txt', 'delete');
        fs.unlinkSync(process.cwd() + '/delete-me.txt');
        fs.writeFileSync(process.cwd() + '/delete-me-async.txt', 'delete');
        await fs.promises.unlink(process.cwd() + '/delete-me-async.txt');
        fs.mkdirSync(process.cwd() + '/delete-dir');
        fs.rmSync(process.cwd() + '/delete-dir', { recursive: true, force: true });
        fs.mkdirSync(process.cwd() + '/delete-dir-async');
        await fs.promises.rm(process.cwd() + '/delete-dir-async', { recursive: true, force: true });
        fs.writeFileSync(process.cwd() + '/rename-source.txt', 'renamed');
        fs.renameSync(process.cwd() + '/rename-source.txt', process.cwd() + '/rename-target.txt');
        await fs.promises.writeFile(process.cwd() + '/rename-source-async.txt', 'renamed-async');
        await fs.promises.rename(process.cwd() + '/rename-source-async.txt', process.cwd() + '/rename-target-async.txt');
        fs.mkdirSync(process.cwd() + '/linked-source');
        fs.writeFileSync(process.cwd() + '/linked-source/package.json', '{"name":"linked-source"}');
        fs.symlinkSync(process.cwd() + '/linked-source', process.cwd() + '/linked-package', 'dir');
        await fs.promises.symlink(process.cwd() + '/linked-source', process.cwd() + '/linked-package-async', 'dir');
        if (fs.readlinkSync(process.cwd() + '/linked-package') !== process.cwd() + '/linked-source') {
          throw new Error('unexpected sync readlink');
        }
        if (await fs.promises.readlink(process.cwd() + '/linked-package-async') !== process.cwd() + '/linked-source') {
          throw new Error('unexpected async readlink');
        }
        const fd = fs.openSync(process.cwd() + '/fd.txt', 'w');
        const bytesWritten = fs.writeSync(fd, 'fd');
        if (bytesWritten !== 2) throw new Error('unexpected write length');
        fs.closeSync(fd);
        const numericFd = fs.openSync(process.cwd() + '/numeric-fd.txt', fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_TRUNC);
        fs.writeSync(numericFd, 'numeric');
        fs.futimesSync(numericFd, new Date(), new Date());
        fs.closeSync(numericFd);
        fs.utimesSync(process.cwd() + '/numeric-fd.txt', new Date(), new Date());
        fs.lutimesSync(process.cwd() + '/numeric-fd.txt', new Date(), new Date());
        await fs.promises.utimes(process.cwd() + '/numeric-fd.txt', new Date(), new Date());
        await new Promise((resolve, reject) => {
          fs.utimes(process.cwd() + '/sync.txt', new Date(), new Date(), (error) => {
            if (error) reject(error);
            else resolve();
          });
        });
        await new Promise((resolve, reject) => {
          const readFd = fs.openSync(process.cwd() + '/sync.txt', 'r+');
          fs.futimes(readFd, new Date(), new Date(), (error) => {
            fs.closeSync(readFd);
            if (error) reject(error);
            else resolve();
          });
        });
        fs.lstat(process.cwd() + '/sync.txt', (lstatError, lstat) => {
          if (lstatError) throw lstatError;
          fs.stat(process.cwd() + '/fd.txt', (statError, stat) => {
            if (statError) throw statError;
            process.stdout.write('wrote ' + lstat.isFile() + ' ' + stat.isFile() + '\\n');
          });
        });
      };
    `
  },
  {
    path: "/workspace/write-cli/package/package.json",
    data: JSON.stringify({ name: "write-fixture-cli", version: "1.2.3", main: "lib/cli.js" })
  },
  {
    path: "/workspace/async-error-cli/package/bin/npm-cli.js",
    data: "#!/usr/bin/env node\nrequire('../lib/cli.js')(process)\n"
  },
  {
    path: "/workspace/async-error-cli/package/lib/cli.js",
    data: `
      module.exports = function run() {
        setTimeout(() => {
          throw new Error('delayed failure');
        }, 0);
      };
    `
  },
  {
    path: "/workspace/async-error-cli/package/package.json",
    data: JSON.stringify({ name: "async-error-fixture-cli", version: "1.2.3", main: "lib/cli.js" })
  },
  {
    path: "/workspace/global-cli/package/bin/npm-cli.js",
    data: "#!/usr/bin/env node\nrequire('../lib/cli.js')(process)\n"
  },
  {
    path: "/workspace/global-cli/package/lib/cli.js",
    data: `
      const { Buffer } = require('buffer');
      module.exports = function run(process) {
        process.stdout.write([
          typeof global.Uint8Array,
          global.Buffer.isBuffer(Buffer.from('ok')),
          Buffer.from('ok') instanceof global.Uint8Array
        ].join(' ') + '\\n');
      };
    `
  },
  {
    path: "/workspace/global-cli/package/package.json",
    data: JSON.stringify({ name: "global-fixture-cli", version: "1.2.3", main: "lib/cli.js" })
  }
]);

const evaluate = createCliModuleEvaluator({
  root: "/workspace",
  reader: workspace
});

const version = evaluate({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/cli/package/bin/npm-cli.js",
    entrySha256: "fixture"
  },
  args: ["--version"],
  cwd: "/workspace/project",
  env: { npm_config_user_agent: "fixture" }
});

assert.deepEqual(version, {
  stdout: "1.2.3\n",
  stderr: "",
  exitCode: 0,
  entry: "/workspace/cli/package/bin/npm-cli.js",
  entrySha256: "fixture"
});

const unsupported = evaluate({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/cli/package/bin/npm-cli.js"
  },
  args: ["install"],
  cwd: "/workspace/project"
});

assert.equal(unsupported.stdout, "");
assert.equal(unsupported.stderr, "unsupported command\n");
assert.equal(unsupported.exitCode, 7);

const evaluateAsync = createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: workspace
});
const asyncVersion = await evaluateAsync({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/async-cli/package/bin/npm-cli.js"
  },
  args: ["--version"],
  cwd: "/workspace/project"
});
assert.equal(asyncVersion.stdout, "async-version\n");
assert.equal(asyncVersion.stderr, "");
assert.equal(asyncVersion.exitCode, 0);

const writeResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: workspace,
  writer: workspace,
  settleTicks: 20
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/write-cli/package/bin/npm-cli.js"
  },
  args: ["write"],
  cwd: "/workspace/project"
});
assert.equal(writeResult.stdout, "wrote true true\n");
assert.equal(writeResult.stderr, "");
assert.equal(writeResult.exitCode, 0);
assert.equal(workspace.readText("/workspace/project/sync.txt"), "sync");
assert.equal(workspace.readText("/workspace/project/.cache/async.txt"), "async");
assert.equal(workspace.readText("/workspace/project/fd.txt"), "fd");
assert.equal(workspace.readText("/workspace/project/numeric-fd.txt"), "numeric");
assert.equal(workspace.exists("/workspace/project/delete-me.txt"), false);
assert.equal(workspace.exists("/workspace/project/delete-me-async.txt"), false);
assert.equal(workspace.exists("/workspace/project/delete-dir"), false);
assert.equal(workspace.exists("/workspace/project/delete-dir-async"), false);
assert.equal(workspace.exists("/workspace/project/rename-source.txt"), false);
assert.equal(workspace.readText("/workspace/project/rename-target.txt"), "renamed");
assert.equal(workspace.exists("/workspace/project/rename-source-async.txt"), false);
assert.equal(workspace.readText("/workspace/project/rename-target-async.txt"), "renamed-async");
assert.equal(workspace.readText("/workspace/project/linked-package/package.json"), '{"name":"linked-source"}');
assert.equal(workspace.readText("/workspace/project/linked-package-async/package.json"), '{"name":"linked-source"}');

const asyncErrorResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: workspace,
  settleTicks: 10,
  settleTimeoutMs: 10
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/async-error-cli/package/bin/npm-cli.js"
  },
  args: [],
  cwd: "/workspace/project"
});
assert.equal(asyncErrorResult.stdout, "");
assert.match(asyncErrorResult.stderr, /delayed failure/);
assert.equal(asyncErrorResult.exitCode, 1);

const globalResult = createCliModuleEvaluator({
  root: "/workspace",
  reader: workspace
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/global-cli/package/bin/npm-cli.js"
  },
  args: [],
  cwd: "/workspace/project"
});
assert.equal(globalResult.stdout, "function true true\n");
assert.equal(globalResult.stderr, "");
assert.equal(globalResult.exitCode, 0);

const entry = {
  name: "npm",
  version: "1.2.3",
  entry: "/workspace/cli/package/bin/npm-cli.js",
  entrySha256: "fixture"
};
const npm = createNpmRunner({
  registry: {
    resolve() {
      return entry;
    }
  },
  processRunner: createGuestRuntimeProcessRunner({
    artifacts: workspace,
    cliModuleEvaluation: {
      root: "/workspace",
      reader: workspace
    }
  })
});
const guestVersion = npm.version("/workspace/project");
assert.equal(guestVersion.runtime, "browser-guest-node-runtime");
assert.equal(guestVersion.bootMode, "cli-module-evaluation");
assert.equal(guestVersion.commandKind, "version");
assert.equal(guestVersion.stdout, "1.2.3\n");
assert.equal(guestVersion.stderr, "");
assert.equal(guestVersion.exitCode, 0);
assert.equal(guestVersion.entrySha256, "fixture");

console.log("package manager cli evaluator test ok");
