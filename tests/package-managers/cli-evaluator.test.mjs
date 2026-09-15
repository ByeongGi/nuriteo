import assert from "node:assert/strict";

import {
  classifyCliEntryModuleMode,
  createAsyncCliModuleEvaluator,
  createCliModuleEvaluator,
  createGuestRuntimeProcessRunner,
  createNpmRunner,
  inspectCliEntryReadiness,
  MemoryPackageManagerWorkspace
} from "../../packages/node-runtime/src/index.ts";

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
      const { Buffer } = require('buffer');
      module.exports = async function run(process) {
        fs.mkdirSync(process.cwd() + '/.cache');
        const tempDir = fs.mkdtempSync(process.cwd() + '/.cache/tmp-');
        if (!tempDir.startsWith(process.cwd() + '/.cache/tmp-')) {
          throw new Error('unexpected mkdtempSync path');
        }
        const asyncTempDir = await fs.promises.mkdtemp(process.cwd() + '/.cache/async-tmp-');
        if (!asyncTempDir.startsWith(process.cwd() + '/.cache/async-tmp-')) {
          throw new Error('unexpected promises.mkdtemp path');
        }
        const watchEvents = [];
        const watcher = fs.watch(process.cwd(), (eventType, filename) => {
          watchEvents.push(eventType + ':' + filename);
        });
        watcher.on('change', (eventType, filename) => {
          watchEvents.push('on:' + eventType + ':' + filename);
        });
        const fileEvents = [];
        const fileWatcher = fs.watchFile(process.cwd() + '/watched.txt', (_current, previous) => {
          fileEvents.push(previous === undefined ? 'created' : 'changed');
        });
        fs.writeFileSync(process.cwd() + '/sync.txt', 'sync');
        fs.writeFileSync(process.cwd() + '/watched.txt', 'one');
        fs.writeFileSync(process.cwd() + '/watched.txt', 'two');
        await Promise.resolve();
        watcher.close();
        fileWatcher.close();
        fs.unwatchFile(process.cwd() + '/watched.txt');
        if (!watchEvents.includes('change:sync.txt') || !watchEvents.includes('on:change:sync.txt') || !watchEvents.includes('change:watched.txt')) {
          throw new Error('unexpected fs.watch events: ' + watchEvents.join(','));
        }
        if (fileEvents.length !== 2 || fileEvents[0] !== 'created' || fileEvents[1] !== 'changed') {
          throw new Error('unexpected fs.watchFile events: ' + fileEvents.join(','));
        }
        fs.chmodSync(process.cwd() + '/sync.txt', 0o755);
        fs.chownSync(process.cwd() + '/sync.txt', 0, 0);
        await fs.promises.chmod(process.cwd() + '/sync.txt', 0o755);
        await fs.promises.chown(process.cwd() + '/sync.txt', 0, 0);
        await fs.promises.lchmod(process.cwd() + '/sync.txt', 0o755);
        await fs.promises.lchown(process.cwd() + '/sync.txt', 0, 0);
        const syncHandle = await fs.promises.open(process.cwd() + '/sync.txt', 'r+');
        const readBuffer = Buffer.alloc(2);
        const readResult = await syncHandle.read(readBuffer, 0, 2, 1);
        if (readResult.bytesRead !== 2 || readBuffer.toString() !== 'yn') {
          throw new Error('unexpected FileHandle read result');
        }
        await syncHandle.chmod(0o755);
        await syncHandle.chown(0, 0);
        await syncHandle.sync();
        await syncHandle.close();
        if (!Buffer.isBuffer(fs.readFileSync(process.cwd() + '/sync.txt'))) {
          throw new Error('readFileSync without encoding must return Buffer');
        }
        if (fs.statSync(process.cwd() + '/missing.txt', { throwIfNoEntry: false }) !== undefined) {
          throw new Error('statSync throwIfNoEntry false should return undefined');
        }
        const rootEntries = fs.readdirSync(process.cwd(), { withFileTypes: true });
        if (!rootEntries.some((entry) => entry.name === 'sync.txt' && entry.isFile() && !entry.isSymbolicLink())) {
          throw new Error('unexpected dirent result');
        }
        await fs.promises.writeFile(process.cwd() + '/.cache/async.txt', 'async');
        await fs.promises.lstat(process.cwd() + '/.cache/async.txt');
        if (await fs.promises.stat(process.cwd() + '/missing-async.txt', { throwIfNoEntry: false }) !== undefined) {
          throw new Error('promises.stat throwIfNoEntry false should return undefined');
        }
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
        fs.copyFileSync(process.cwd() + '/rename-target.txt', process.cwd() + '/copied.txt');
        await fs.promises.copyFile(process.cwd() + '/rename-target-async.txt', process.cwd() + '/copied-async.txt');
        fs.linkSync(process.cwd() + '/copied.txt', process.cwd() + '/linked-file.txt');
        await fs.promises.link(process.cwd() + '/copied-async.txt', process.cwd() + '/linked-file-async.txt');
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
        fs.fchmodSync(numericFd, 0o644);
        fs.fchownSync(numericFd, 0, 0);
        fs.fsyncSync(numericFd);
        await fs.promises.fchmod(numericFd, 0o644);
        await fs.promises.fchown(numericFd, 0, 0);
        await fs.promises.fsync(numericFd);
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
        let statCallbackWasSync = true;
        fs.stat(process.cwd() + '/sync.txt', (statError) => {
          if (statError) throw statError;
          if (statCallbackWasSync) throw new Error('fs.stat callback should be async');
        });
        statCallbackWasSync = false;
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
      const { EventEmitter } = require('events');
      class BundleWalker extends EventEmitter {
        addListener(event, listener) {
          return this.on(event, listener);
        }
        on(event, listener) {
          const result = super.on(event, listener);
          if (event === 'done') this.emit('done', 'ok');
          return result;
        }
      }
      module.exports = function run(process) {
        let eventValue = '';
        new BundleWalker().once('done', (value) => {
          eventValue = value;
        });
        process.stdout.write([
          typeof global.Uint8Array,
          global.Buffer.isBuffer(Buffer.from('ok')),
          Buffer.from('ok') instanceof global.Uint8Array,
          eventValue
        ].join(' ') + '\\n');
      };
    `
  },
  {
    path: "/workspace/global-cli/package/package.json",
    data: JSON.stringify({ name: "global-fixture-cli", version: "1.2.3", main: "lib/cli.js" })
  },
  {
    path: "/workspace/esm-cli/package/bin/vite.js",
    data: "#!/usr/bin/env node\nimport '../dist/node/cli.js';\n"
  },
  {
    path: "/workspace/esm-cli/package/dist/node/cli.js",
    data: `
      import { createRequire } from 'node:module';
      import defaultLabel, { namedLabel as renamedLabel, Factory } from './labels.js';
      import { reExportedLabel } from './re-export.js';
      import { starLabel, starNamespace } from './star.js';
      import * as namespaceLabels from './namespace.js';
      const require = createRequire(import.meta.url);
      const config = require('./config.cjs');
      const manifest = require('../../package.json');
      const configResolved = require.resolve('./config.cjs').endsWith('/dist/node/config.cjs');
      process.stdout.write(defaultLabel + ' ' + renamedLabel() + ' ' + namespaceLabels.namespaceLabel + ' ' + new Factory().label() + ' ' + reExportedLabel + ' ' + starLabel + ' ' + starNamespace.starLabel + ' ' + config.label + ' ' + manifest.version + ' ' + configResolved + '\\n');
      export const started = true;
    `
  },
  {
    path: "/workspace/esm-cli/package/dist/node/config.cjs",
    data: "module.exports = { label: 'createRequire' };\n"
  },
  {
    path: "/workspace/esm-cli/package/dist/node/labels.js",
    data: `
      const defaultLabel = 'vite';
      export function namedLabel() {
        return 'esm';
      }
      export class Factory {
        label() {
          return 'class';
        }
      }
      export default defaultLabel;
    `
  },
  {
    path: "/workspace/esm-cli/package/dist/node/re-export.js",
    data: "export { namespaceLabel as reExportedLabel } from './namespace.js';\n"
  },
  {
    path: "/workspace/esm-cli/package/dist/node/namespace.js",
    data: "export const namespaceLabel = 'boot';\n"
  },
  {
    path: "/workspace/esm-cli/package/dist/node/star.js",
    data: "export * from './star-source.js';\nexport * as starNamespace from './star-source.js';\n"
  },
  {
    path: "/workspace/esm-cli/package/dist/node/star-source.js",
    data: "export const starLabel = 'star';\nexport default 'hidden';\n"
  },
  {
    path: "/workspace/esm-cli/package/package.json",
    data: JSON.stringify({ name: "esm-fixture-cli", version: "1.2.3", type: "module", bin: { vite: "bin/vite.js" } })
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
  settleTicks: 100,
  settleTimeoutMs: 10
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
assert.equal(workspace.readText("/workspace/project/copied.txt"), "renamed");
assert.equal(workspace.readText("/workspace/project/copied-async.txt"), "renamed-async");
assert.equal(workspace.readText("/workspace/project/linked-file.txt"), "renamed");
assert.equal(workspace.readText("/workspace/project/linked-file-async.txt"), "renamed-async");
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
assert.equal(globalResult.stdout, "function true true ok\n");
assert.equal(globalResult.stderr, "");
assert.equal(globalResult.exitCode, 0);

const esmCliEntry = {
  name: "vite",
  version: "1.2.3",
  entry: "/workspace/esm-cli/package/bin/vite.js"
};
assert.equal(classifyCliEntryModuleMode({ entry: esmCliEntry, reader: workspace }), "esm");
assert.deepEqual(inspectCliEntryReadiness({ entry: esmCliEntry, reader: workspace }), {
  status: "blocked",
  entry: "/workspace/esm-cli/package/bin/vite.js",
  mode: "esm",
  reasons: [
    {
      code: "ERR_CLI_ESM_ENTRY_UNSUPPORTED",
      message: "ESM CLI entrypoint requires async module entry execution: /workspace/esm-cli/package/bin/vite.js"
    }
  ],
  nextAction: "Add async ESM CLI entry execution before routing this command through the browser guest runtime."
});
assert.equal(inspectCliEntryReadiness({ entry: esmCliEntry, reader: workspace, supportedModes: ["cjs", "esm"] }).status, "ready");
const esmResult = createCliModuleEvaluator({
  root: "/workspace",
  reader: workspace
})({
  entry: esmCliEntry,
  args: ["--host", "127.0.0.1"],
  cwd: "/workspace/project"
});
assert.equal(esmResult.stdout, "");
assert.match(esmResult.stderr, /ERR_CLI_ESM_ENTRY_UNSUPPORTED/);
assert.equal(esmResult.exitCode, 1);
const asyncEsmResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: workspace
})({
  entry: esmCliEntry,
  args: ["--host", "127.0.0.1"],
  cwd: "/workspace/project"
});
assert.equal(asyncEsmResult.stdout, "vite esm boot class boot star star createRequire 1.2.3 true\n");
assert.equal(asyncEsmResult.stderr, "");
assert.equal(asyncEsmResult.exitCode, 0);

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
