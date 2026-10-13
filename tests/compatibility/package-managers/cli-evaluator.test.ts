import assert from "node:assert/strict";

import {
  classifyCliEntryModuleMode,
  createAsyncCliModuleEvaluator,
  createCliEvaluationHttpBridge,
  createCliModuleEvaluator,
  createLoopbackNetwork,
  createGuestRuntimeProcessRunner,
  createIsolatedAsyncCliModuleEvaluator,
  createWorkerBackedAsyncCliModuleEvaluator,
  createNpmRunner,
  evaluateCliModuleWorkerMessage,
  inspectCliEntryReadiness,
  MemoryPackageManagerWorkspace
} from "../../../packages/node-runtime/src/index.ts";

class FakeCliEvaluationWorker {
  #listeners = {
    message: new Set(),
    error: new Set()
  };
  #httpBridges = new Map();
  #terminated = false;

  addEventListener(type, listener) {
    this.#listeners[type].add(listener);
  }

  removeEventListener(type, listener) {
    this.#listeners[type].delete(listener);
  }

  postMessage(message) {
    queueMicrotask(async () => {
      if (this.#terminated) return;
      try {
        if (message.type === "cli:http:request") {
          const bridge = this.#httpBridges.get(message.evaluationId);
          if (!bridge) throw new Error(`missing CLI HTTP bridge: ${message.evaluationId}`);
          const response = {
            evaluationId: message.evaluationId,
            id: message.id,
            response: await bridge.handleRequest(message.port, message.request),
            type: "cli:http:response"
          };
          for (const listener of this.#listeners.message) listener({ data: response });
          return;
        }
        const bridge = message.bridgeLoopbackServer ? createCliEvaluationHttpBridge() : null;
        const response = await evaluateCliModuleWorkerMessage(message, bridge ? { httpBridge: bridge } : {});
        if (bridge && response.result?.bridgedServerPorts?.length) this.#httpBridges.set(message.id, bridge);
        for (const listener of this.#listeners.message) listener({ data: response });
      } catch (error) {
        for (const listener of this.#listeners.error) listener({ message: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  terminate() {
    this.#terminated = true;
    this.#listeners.message.clear();
    this.#listeners.error.clear();
  }
}

class NonRespondingCliEvaluationWorker {
  terminated = false;

  addEventListener() {}

  removeEventListener() {}

  postMessage() {}

  terminate() {
    this.terminated = true;
  }
}

class HangingBridgeCliEvaluationWorker {
  #listeners = {
    message: new Set(),
    error: new Set()
  };
  terminated = false;

  addEventListener(type, listener) {
    this.#listeners[type].add(listener);
  }

  removeEventListener(type, listener) {
    this.#listeners[type].delete(listener);
  }

  postMessage(message) {
    if (message.type !== "cli:evaluate") return;
    queueMicrotask(() => {
      for (const listener of this.#listeners.message) {
        listener({
          data: {
            id: message.id,
            result: {
              bridgedServerPorts: [6125],
              entry: message.request.entry.entry,
              exitCode: 0,
              stderr: "",
              stdout: "",
              workspaceSnapshot: message.workspaceSnapshot
            },
            type: "cli:result"
          }
        });
      }
    });
  }

  emitError(message) {
    for (const listener of this.#listeners.error) listener({ message });
  }

  terminate() {
    this.terminated = true;
    this.#listeners.message.clear();
    this.#listeners.error.clear();
  }
}

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
        const cwdModifiedBeforeWrite = fs.statSync(process.cwd()).mtimeMs;
        fs.writeFileSync(process.cwd() + '/sync.txt', 'sync');
        if (fs.statSync(process.cwd()).mtimeMs <= cwdModifiedBeforeWrite) {
          throw new Error('parent directory mtime did not advance after a file write');
        }
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
        const syncDir = fs.opendirSync(process.cwd());
        if (syncDir.path !== process.cwd() || !syncDir.readSync()) {
          throw new Error('unexpected opendirSync result');
        }
        syncDir.closeSync();
        const asyncDir = await fs.promises.opendir(process.cwd());
        const asyncDirEntries = [];
        for await (const entry of asyncDir) {
          asyncDirEntries.push(entry.name);
        }
        if (!asyncDirEntries.includes('sync.txt')) {
          throw new Error('unexpected promises.opendir entries: ' + asyncDirEntries.join(','));
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
        fs.cpSync(process.cwd() + '/copied.txt', process.cwd() + '/cp-file.txt');
        if (fs.readFileSync(process.cwd() + '/cp-file.txt', 'utf8') !== 'renamed') {
          throw new Error('unexpected cpSync file copy');
        }
        fs.mkdirSync(process.cwd() + '/cp-source');
        fs.writeFileSync(process.cwd() + '/cp-source/nested.txt', 'nested');
        fs.cpSync(process.cwd() + '/cp-source', process.cwd() + '/cp-target', { recursive: true });
        if (fs.readFileSync(process.cwd() + '/cp-target/nested.txt', 'utf8') !== 'nested') {
          throw new Error('unexpected cpSync recursive copy');
        }
        await fs.promises.cp(process.cwd() + '/cp-source', process.cwd() + '/cp-target-async', { recursive: true });
        if (fs.readFileSync(process.cwd() + '/cp-target-async/nested.txt', 'utf8') !== 'nested') {
          throw new Error('unexpected promises.cp recursive copy');
        }
        const streamedRead = await new Promise((resolve, reject) => {
          let text = '';
          fs.createReadStream(process.cwd() + '/copied.txt', { encoding: 'utf8' })
            .on('data', (chunk) => {
              text += chunk;
            })
            .on('error', reject)
            .on('end', () => resolve(text));
        });
        if (streamedRead !== 'renamed') {
          throw new Error('unexpected createReadStream data: ' + streamedRead);
        }
        await new Promise((resolve, reject) => {
          const stream = fs.createWriteStream(process.cwd() + '/streamed-write.txt');
          stream.on('error', reject);
          stream.on('finish', resolve);
          stream.write('streamed');
          stream.end('-write');
        });
        if (fs.readFileSync(process.cwd() + '/streamed-write.txt', 'utf8') !== 'streamed-write') {
          throw new Error('unexpected createWriteStream output');
        }
        await new Promise((resolve, reject) => {
          const stream = new fs.WriteStream(process.cwd() + '/constructed-stream.txt');
          stream.on('error', reject);
          stream.on('finish', resolve);
          stream.end('constructed');
        });
        if (fs.readFileSync(process.cwd() + '/constructed-stream.txt', 'utf8') !== 'constructed') {
          throw new Error('unexpected WriteStream constructor output');
        }
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
    path: "/workspace/relative-cli/package/bin/npm-cli.js",
    data: "#!/usr/bin/env node\nrequire('../lib/cli.js')(process)\n"
  },
  {
    path: "/workspace/relative-cli/package/lib/cli.js",
    data: `
      const fs = require('fs');
      module.exports = async function run(process) {
        const initialMtime = fs.statSync('relative.txt').mtimeMs;
        fs.writeFileSync('created.txt', 'created');
        await fs.promises.writeFile('created-async.txt', 'async-created');
        const callbackExists = await new Promise((resolve) => fs.exists('relative.txt', resolve));
        const values = [
          fs.existsSync('relative.txt'),
          callbackExists,
          fs.readFileSync('relative.txt', 'utf8'),
          fs.statSync('relative.txt').isFile(),
          fs.statSync('relative.txt').mtime instanceof Date,
          typeof fs.statSync('relative.txt').mtimeMs,
          initialMtime > 0,
          fs.statSync('created.txt').mtimeMs > initialMtime,
          fs.readdirSync('.').includes('relative.txt'),
          await fs.promises.readFile('relative.txt', 'utf8'),
          fs.readFileSync('created.txt', 'utf8'),
          await fs.promises.readFile('created-async.txt', 'utf8')
        ];
        process.stdout.write(values.join(':') + '\\n');
      };
    `
  },
  {
    path: "/workspace/relative-cli/package/package.json",
    data: JSON.stringify({ name: "relative-fixture-cli", version: "1.2.3", main: "lib/cli.js" })
  },
  {
    path: "/workspace/project/relative.txt",
    data: "hello"
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
    path: "/workspace/async-exit-cli/package/bin/npm-cli.js",
    data: `
      setTimeout(() => {
        process.stdout.write('finished\\n');
        process.exit(0);
      }, 5);
    `
  },
  {
    path: "/workspace/async-exit-cli/package/package.json",
    data: JSON.stringify({ name: "async-exit-fixture-cli", version: "1.2.3", bin: { npm: "bin/npm-cli.js" } })
  },
  {
    path: "/workspace/timer-cli/package/bin/npm-cli.js",
    data: `
      const { setInterval } = require('node:timers');
      setInterval(() => process.stdout.write('tick\\n'), 1);
    `
  },
  {
    path: "/workspace/timer-cli/package/package.json",
    data: JSON.stringify({ name: "timer-fixture-cli", version: "1.2.3", bin: { npm: "bin/npm-cli.js" } })
  },
  {
    path: "/workspace/error-cause-cli/package/bin/npm-cli.js",
    data: "#!/usr/bin/env node\nrequire('../lib/cli.js')()\n"
  },
  {
    path: "/workspace/error-cause-cli/package/lib/cli.js",
    data: `
      module.exports = function run() {
        throw new Error('top failure', { cause: new Error('nested native binding failure') });
      };
    `
  },
  {
    path: "/workspace/error-cause-cli/package/package.json",
    data: JSON.stringify({ name: "error-cause-fixture-cli", version: "1.2.3", main: "lib/cli.js" })
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
          global.Buffer('ok').toString(),
          Buffer.from('ok') instanceof global.Uint8Array,
          globalThis.process === process,
          globalThis.crypto.getRandomValues(new Uint8Array(1)) instanceof Uint8Array,
          typeof globalThis.WebAssembly,
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
    path: "/workspace/worker-cli/package/bin/npm-cli.js",
    data: "#!/usr/bin/env node\nrequire('../lib/cli.js')(process)\n"
  },
  {
    path: "/workspace/worker-cli/package/lib/cli.js",
    data: `
      const { Worker } = require('node:worker_threads');
      module.exports = function run(process) {
        const worker = new Worker('/workspace/worker-cli/package/lib/worker.cjs', {
          workerData: { label: 'wasi' }
        });
        worker.onmessage = ({ data }) => {
          process.stdout.write(data + '\\n');
        };
        worker.on('error', (error) => {
          process.stderr.write(error.message + '\\n');
        });
      };
    `
  },
  {
    path: "/workspace/worker-cli/package/lib/worker.cjs",
    data: `
      const { parentPort, workerData, isMainThread } = require('node:worker_threads');
      parentPort.postMessage([
        isMainThread,
        workerData.label,
        globalThis.process === process,
        typeof globalThis.WebAssembly,
        Array.isArray(process.execArgv)
      ].join(':'));
    `
  },
  {
    path: "/workspace/worker-cli/package/package.json",
    data: JSON.stringify({ name: "worker-fixture-cli", version: "1.2.3", main: "lib/cli.js" })
  },
  {
    path: "/workspace/esm-cli/package/bin/vite.js",
    data: "#!/usr/bin/env node\nimport '../dist/node/cli.js';\n"
  },
  {
    path: "/workspace/esm-cli/package/dist/node/cli.js",
    data: `
      import { createRequire } from 'node:module';
      import { performance } from 'node:perf_hooks';
      import defaultLabel, { namedLabel as renamedLabel, Factory } from './labels.js';
      import { reExportedLabel } from './re-export.js';
      import { starLabel, starNamespace } from './star.js';
      import * as namespaceLabels from './namespace.js';
      const require = createRequire(import.meta.url);
      const mark = performance.mark('vite-cli-start');
      const config = require('./config.cjs');
      const manifest = require('../../package.json');
      const configResolved = require.resolve('./config.cjs').endsWith('/dist/node/config.cjs');
      process.stdout.write(defaultLabel + ' ' + renamedLabel() + ' ' + namespaceLabels.namespaceLabel + ' ' + new Factory().label() + ' ' + reExportedLabel + ' ' + starLabel + ' ' + starNamespace.starLabel + ' ' + config.label + ' ' + manifest.version + ' ' + configResolved + ' ' + mark.entryType + '\\n');
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
  },
  {
    path: "/workspace/bundle-process-cli/package/bin/vite.js",
    data: "#!/usr/bin/env node\nimport '../dist/node/cli.js';\n"
  },
  {
    path: "/workspace/bundle-process-cli/package/dist/node/cli.js",
    data: `
      import process$1 from 'node:process';
      process.stdin.on('data', () => {});
      process.stdout.write(process.cwd() + '|' + process$1.cwd() + '|' + typeof process.stdin.on + '\\n');
      export const started = true;
    `
  },
  {
    path: "/workspace/bundle-process-cli/package/package.json",
    data: JSON.stringify({ name: "bundle-process-fixture-cli", version: "1.2.3", type: "module", bin: { vite: "bin/vite.js" } })
  },
  {
    path: "/workspace/unawaited-dynamic-cli/package/bin/vite.js",
    data: `
      function start() {
        return import('../dist/node/missing.js');
      }
      start();
    `
  },
  {
    path: "/workspace/unawaited-dynamic-cli/package/package.json",
    data: JSON.stringify({ name: "unawaited-dynamic-cli", version: "1.2.3", type: "module", bin: { vite: "bin/vite.js" } })
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
assert.equal(writeResult.stdout, "wrote true true\n", JSON.stringify(writeResult));
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

const relativeResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: workspace,
  writer: workspace
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/relative-cli/package/bin/npm-cli.js"
  },
  args: ["relative"],
  cwd: "/workspace/project"
});
assert.equal(relativeResult.stdout, "true:true:hello:true:true:number:true:true:true:hello:created:async-created\n");
assert.equal(relativeResult.stderr, "");
assert.equal(relativeResult.exitCode, 0);
assert.equal(workspace.readText("/workspace/project/created.txt"), "created");
assert.equal(workspace.readText("/workspace/project/created-async.txt"), "async-created");

const isolatedWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/write-cli/package/bin/npm-cli.js",
    data: "#!/usr/bin/env node\nrequire('../lib/cli.js')(process)\n"
  },
  {
    path: "/workspace/write-cli/package/lib/cli.js",
    data: `
      const fs = require('fs');
      module.exports = function run(process) {
        fs.writeFileSync(process.cwd() + '/isolated.txt', 'isolated');
        process.stdout.write('isolated-write\\n');
      };
    `
  },
  {
    path: "/workspace/write-cli/package/package.json",
    data: JSON.stringify({ name: "isolated-write-cli", version: "1.2.3", main: "lib/cli.js" })
  }
]);
const isolatedResult = await createIsolatedAsyncCliModuleEvaluator({
  root: "/workspace",
  workspace: isolatedWorkspace
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/write-cli/package/bin/npm-cli.js"
  },
  args: [],
  cwd: "/workspace/project"
});
assert.equal(isolatedResult.stdout, "isolated-write\n");
assert.equal(isolatedResult.stderr, "");
assert.equal(isolatedResult.exitCode, 0);
assert.equal(isolatedWorkspace.exists("/workspace/project/isolated.txt"), false);
assert.equal(
  MemoryPackageManagerWorkspace.fromSnapshot(isolatedResult.workspaceSnapshot).readText("/workspace/project/isolated.txt"),
  "isolated"
);

const workerBackedWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/write-cli/package/bin/npm-cli.js",
    data: "#!/usr/bin/env node\nrequire('../lib/cli.js')(process)\n"
  },
  {
    path: "/workspace/write-cli/package/lib/cli.js",
    data: `
      const fs = require('fs');
      module.exports = function run(process) {
        fs.writeFileSync(process.cwd() + '/worker-backed.txt', 'worker-backed');
        process.stdout.write('worker-backed-write\\n');
      };
    `
  },
  {
    path: "/workspace/write-cli/package/package.json",
    data: JSON.stringify({ name: "worker-backed-write-cli", version: "1.2.3", main: "lib/cli.js" })
  }
]);
const workerBackedResult = await createWorkerBackedAsyncCliModuleEvaluator({
  captureGlobalCalls: ["__fixtureRegister"],
  root: "/workspace",
  workerFactory: () => new FakeCliEvaluationWorker(),
  workspace: workerBackedWorkspace
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/write-cli/package/bin/npm-cli.js"
  },
  args: [],
  cwd: "/workspace/project"
});
assert.equal(workerBackedResult.stdout, "worker-backed-write\n");
assert.equal(workerBackedResult.stderr, "");
assert.equal(workerBackedResult.exitCode, 0);
assert.equal(workerBackedWorkspace.exists("/workspace/project/worker-backed.txt"), false);
assert.equal(
  MemoryPackageManagerWorkspace.fromSnapshot(workerBackedResult.workspaceSnapshot).readText("/workspace/project/worker-backed.txt"),
  "worker-backed"
);
assert.deepEqual(workerBackedResult.capturedGlobalCalls, []);

const workerBackedRegistrationWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/register-cli/package/bin/npm-cli.js",
    data: "#!/usr/bin/env node\nrequire('../lib/cli.js')(process)\n"
  },
  {
    path: "/workspace/register-cli/package/lib/cli.js",
    data: `
      module.exports = function run(process) {
        global.__fixtureRegister?.({
          command: 'dev',
          nested: { ok: true },
          invoke() { return 'not-serializable'; }
        });
        process.stdout.write('registered\\n');
      };
    `
  },
  {
    path: "/workspace/register-cli/package/package.json",
    data: JSON.stringify({ name: "worker-backed-register-cli", version: "1.2.3", main: "lib/cli.js" })
  }
]);
const workerBackedRegistrationResult = await createWorkerBackedAsyncCliModuleEvaluator({
  captureGlobalCalls: ["__fixtureRegister"],
  root: "/workspace",
  workerFactory: () => new FakeCliEvaluationWorker(),
  workspace: workerBackedRegistrationWorkspace
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/register-cli/package/bin/npm-cli.js"
  },
  args: [],
  cwd: "/workspace/project"
});
assert.equal(workerBackedRegistrationResult.stdout, "registered\n");
assert.deepEqual(workerBackedRegistrationResult.capturedGlobalCalls, [
  {
    name: "__fixtureRegister",
    args: [
      {
        command: "dev",
        nested: { ok: true },
        invoke: { __cliFunctionRef: true }
      }
    ]
  }
]);

const workerBackedEsmBootstrapWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/vite/package/bin/vite.mjs",
    data: `
      import { performance } from 'node:perf_hooks';
      import module from 'node:module';
      global.__vite_start_time = performance.now();
      function start() {
        module.enableCompileCache?.();
        return import('../dist/node/cli.mjs');
      }
      if (process.argv.includes('--profile')) {
        // profile boot path remains outside the CSP-safe subset.
      } else {
        start();
      }
    `
  },
  {
    path: "/workspace/vite/package/dist/node/cli.mjs",
    data: `
      global.__fixtureRegister?.({
        command: 'dev',
        source: 'vite-cli',
        startedAt: global.__vite_start_time,
        invoke() { return 'not-serializable'; }
      });
    `
  },
  {
    path: "/workspace/vite/package/package.json",
    data: JSON.stringify({ name: "vite", version: "0.0.0-worker-bootstrap", type: "module", bin: { vite: "bin/vite.mjs" } })
  }
]);
const workerBackedEsmBootstrapResult = await createWorkerBackedAsyncCliModuleEvaluator({
  captureGlobalCalls: ["__fixtureRegister"],
  root: "/workspace",
  workerFactory: () => new FakeCliEvaluationWorker(),
  workspace: workerBackedEsmBootstrapWorkspace
})({
  entry: {
    name: "vite",
    version: "0.0.0-worker-bootstrap",
    entry: "/workspace/vite/package/bin/vite.mjs"
  },
  args: [],
  cwd: "/workspace/project"
});
assert.equal(workerBackedEsmBootstrapResult.stderr, "");
assert.equal(workerBackedEsmBootstrapResult.exitCode, 0);
assert.equal(workerBackedEsmBootstrapResult.capturedGlobalCalls.length, 1);
assert.equal(workerBackedEsmBootstrapResult.capturedGlobalCalls[0].name, "__fixtureRegister");
assert.equal(workerBackedEsmBootstrapResult.capturedGlobalCalls[0].args[0].command, "dev");
assert.equal(workerBackedEsmBootstrapResult.capturedGlobalCalls[0].args[0].source, "vite-cli");
assert.equal(typeof workerBackedEsmBootstrapResult.capturedGlobalCalls[0].args[0].startedAt, "number");
assert.deepEqual(workerBackedEsmBootstrapResult.capturedGlobalCalls[0].args[0].invoke, { __cliFunctionRef: true });

const fileFetchWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/fetch/package/bin/fetch-wasm.mjs",
    data: `
      const wasmUrl = new globalThis.URL('./probe.wasm', import.meta.url).href;
      const response = await globalThis.fetch(wasmUrl);
      const bytes = new Uint8Array(await response.arrayBuffer());
      process.stdout.write(String(response.ok) + ':' + String(bytes.byteLength) + ':' + String(bytes[1]));
    `
  },
  {
    path: "/workspace/fetch/package/bin/probe.wasm",
    data: Buffer.from([0, 255, 1, 2]).toString("base64"),
    encoding: "base64"
  },
  {
    path: "/workspace/fetch/package/package.json",
    data: JSON.stringify({ name: "fetch-wasm", version: "1.0.0", type: "module", bin: { "fetch-wasm": "bin/fetch-wasm.mjs" } })
  }
]);
const fileFetchResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: fileFetchWorkspace
})({
  entry: {
    name: "fetch-wasm",
    version: "1.0.0",
    entry: "/workspace/fetch/package/bin/fetch-wasm.mjs",
    mode: "esm"
  },
  args: [],
  cwd: "/workspace/project"
});
assert.equal(fileFetchResult.stderr, "");
assert.equal(fileFetchResult.exitCode, 0);
assert.equal(fileFetchResult.stdout, "true:4:255");

const staticEsmWorkspace = new MemoryPackageManagerWorkspace([
  { path: "/workspace/static-esm/bin/main.mjs", data: "throw new Error('dynamic evaluation must not run');\n" },
  { path: "/workspace/static-esm/generated/config.mjs", data: "throw new Error('dynamic evaluation must not run');\n" }
]);
const staticEsmResult = await evaluateCliModuleWorkerMessage({
  id: 91,
  request: {
    entry: { name: "static-esm", version: "1.0.0", entry: "/workspace/static-esm/bin/main.mjs", mode: "esm" },
    args: [],
    cwd: "/workspace/static-esm"
  },
  root: "/workspace",
  type: "cli:evaluate",
  workspaceSnapshot: staticEsmWorkspace.snapshot()
}, {
  precompiledEsmFactories: {
    "/workspace/static-esm/bin/main.mjs": async (context) => {
      await context.dynamicImport("file:///workspace/static-esm/generated/config.mjs");
    },
    "/workspace/static-esm/generated/config.mjs": (_context, globals) => {
      globals.process.stdout.write("static-esm-file-url-ready");
    }
  }
});
assert.equal(staticEsmResult.error, undefined);
assert.equal(staticEsmResult.result?.exitCode, 0);
assert.equal(staticEsmResult.result?.stdout, "static-esm-file-url-ready");

const asyncRequireBridgeWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/async-require/package/bin/cli.cjs",
    data: `
      const binding = require('../lib/binding.mjs');
      setTimeout(() => {
        process.stdout.write(String(binding.label));
      }, 0);
    `
  },
  {
    path: "/workspace/async-require/package/lib/binding.mjs",
    data: "const value = await Promise.resolve('async-binding-ready');\nexport const label = value;\n"
  },
  {
    path: "/workspace/async-require/package/package.json",
    data: JSON.stringify({ name: "async-require", version: "1.0.0", bin: { "async-require": "bin/cli.cjs" } })
  }
]);
const asyncRequireBridgeResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: asyncRequireBridgeWorkspace,
  settleTicks: 2,
  settleTimeoutMs: 10
})({
  entry: {
    name: "async-require",
    version: "1.0.0",
    entry: "/workspace/async-require/package/bin/cli.cjs"
  },
  args: [],
  cwd: "/workspace/project"
});
assert.equal(asyncRequireBridgeResult.stderr, "");
assert.equal(asyncRequireBridgeResult.exitCode, 0);
assert.equal(asyncRequireBridgeResult.stdout, "async-binding-ready");

const asyncRequireConstructorBridgeWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/async-constructor/package/bin/cli.cjs",
    data: `
      const binding = require('../lib/binding.mjs');
      const callable = new binding.BindingCallableBuiltinPlugin({ name: 'builtin:test' });
      process.stdout.write(String(callable.getOrder('transform')) + ':' + typeof callable.close + ':' + typeof callable.scan + ':' + typeof callable.write);
      callable.write().then((result) => process.stdout.write(':' + Array.isArray(result.chunks) + ':' + Array.isArray(result.assets)));
    `
  },
  {
    path: "/workspace/async-constructor/package/lib/binding.mjs",
    data: "await Promise.resolve();\nexport class BindingCallableBuiltinPlugin {\n  getOrder() { return 'post'; }\n}\n"
  },
  {
    path: "/workspace/async-constructor/package/package.json",
    data: JSON.stringify({ name: "async-constructor", version: "1.0.0", bin: { "async-constructor": "bin/cli.cjs" } })
  }
]);
const asyncRequireConstructorBridgeResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: asyncRequireConstructorBridgeWorkspace,
  settleTicks: 2,
  settleTimeoutMs: 10
})({
  entry: {
    name: "async-constructor",
    version: "1.0.0",
    entry: "/workspace/async-constructor/package/bin/cli.cjs"
  },
  args: [],
  cwd: "/workspace/project"
});
assert.equal(asyncRequireConstructorBridgeResult.stderr, "");
assert.equal(asyncRequireConstructorBridgeResult.exitCode, 0);
assert.equal(asyncRequireConstructorBridgeResult.stdout, "undefined:function:function:function:true:true");

const asyncRequireBundlerBridgeWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/async-bundler/package/bin/cli.cjs",
    data: `
      const binding = require('../lib/binding.mjs');
      const bundler = new binding.BindingBundler();
      Promise.all([bundler.generate(), bundler.write()]).then(([generated, written]) => {
        process.stdout.write([
          Array.isArray(generated.chunks),
          Array.isArray(generated.assets),
          Array.isArray(written.chunks),
          Array.isArray(written.assets)
        ].join(':'));
      });
    `
  },
  {
    path: "/workspace/async-bundler/package/lib/binding.mjs",
    data: "await Promise.resolve();\nexport class BindingBundler {}\n"
  },
  {
    path: "/workspace/async-bundler/package/package.json",
    data: JSON.stringify({ name: "async-bundler", version: "1.0.0", bin: { "async-bundler": "bin/cli.cjs" } })
  }
]);
const asyncRequireBundlerBridgeResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: asyncRequireBundlerBridgeWorkspace,
  settleTicks: 2,
  settleTimeoutMs: 10
})({
  entry: {
    name: "async-bundler",
    version: "1.0.0",
    entry: "/workspace/async-bundler/package/bin/cli.cjs"
  },
  args: [],
  cwd: "/workspace/project"
});
assert.equal(asyncRequireBundlerBridgeResult.stderr, "");
assert.equal(asyncRequireBundlerBridgeResult.exitCode, 0);
assert.equal(asyncRequireBundlerBridgeResult.stdout, "true:true:true:true");

const asyncRequireBundlerWriteWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/project/index.html",
    data: '<div id="root"></div><script type="module" src="/src/main.ts"></script>\n'
  },
  {
    path: "/workspace/project/src/main.ts",
    data: "const value: number = 1;\ndocument.body.textContent = String(value);\n"
  },
  {
    path: "/workspace/async-bundler-write/package/bin/cli.cjs",
    data: `
      const binding = require('../lib/binding.mjs');
      const bundler = new binding.BindingBundler();
      bundler.write({
        inputOptions: { cwd: '/workspace/project', input: [{ import: '/workspace/project/index.html' }] },
        outputOptions: { dir: '/workspace/project/dist' }
      }).then((result) => process.stdout.write(String(result.chunks.length) + ':' + String(result.assets.length)));
    `
  },
  {
    path: "/workspace/async-bundler-write/package/lib/binding.mjs",
    data: "await Promise.resolve();\nexport class BindingBundler {}\n"
  },
  {
    path: "/workspace/async-bundler-write/package/package.json",
    data: JSON.stringify({ name: "async-bundler-write", version: "1.0.0", bin: { "async-bundler-write": "bin/cli.cjs" } })
  }
]);
const asyncRequireBundlerWriteResult = await createIsolatedAsyncCliModuleEvaluator({
  root: "/workspace",
  workspace: asyncRequireBundlerWriteWorkspace,
  settleTicks: 2,
  settleTimeoutMs: 10
})({
  entry: {
    name: "async-bundler-write",
    version: "1.0.0",
    entry: "/workspace/async-bundler-write/package/bin/cli.cjs"
  },
  args: [],
  cwd: "/workspace/project"
});
assert.equal(asyncRequireBundlerWriteResult.stderr, "");
assert.equal(asyncRequireBundlerWriteResult.exitCode, 0);
assert.equal(asyncRequireBundlerWriteResult.stdout, "1:1");
const bundlerWriteFiles = new Map(asyncRequireBundlerWriteResult.workspaceSnapshot.files.map((file) => [file.path, Buffer.from(file.data, "base64").toString("utf8")]));
assert.match(bundlerWriteFiles.get("/workspace/project/dist/index.html"), /assets\/index\.js/);
assert.equal(bundlerWriteFiles.get("/workspace/project/dist/assets/index.js")?.includes("const value = 1;"), true);

const httpServerBridgeWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/http-server/package/bin/server.cjs",
    data: `
      const http = require('node:http');
      const server = http.createServer((request, response) => {
        response.setHeader('x-cli-server', 'loopback');
        response.appendHeader('x-cli-values', 'one');
        response.appendHeader('x-cli-values', ['two', 'three']);
        response.end('served:' + request.method + ':' + request.url);
      });
      server.listen(6123, '127.0.0.1', () => process.stdout.write('listening'));
    `
  },
  {
    path: "/workspace/http-server/package/package.json",
    data: JSON.stringify({ name: "http-server", version: "1.0.0", bin: { "http-server": "bin/server.cjs" } })
  }
]);
const httpServerNetwork = createLoopbackNetwork();
const httpServerBridgeResult = await createAsyncCliModuleEvaluator({
  loopbackNetwork: httpServerNetwork,
  root: "/workspace",
  reader: httpServerBridgeWorkspace,
  settleTicks: 2,
  settleTimeoutMs: 10
})({
  entry: {
    name: "http-server",
    version: "1.0.0",
    entry: "/workspace/http-server/package/bin/server.cjs"
  },
  args: [],
  cwd: "/workspace/project"
});
assert.equal(httpServerBridgeResult.stderr, "");
assert.equal(httpServerBridgeResult.exitCode, 0);
assert.equal(httpServerBridgeResult.stdout, "listening");
const httpServerResponse = await httpServerNetwork.fetch("http://127.0.0.1:6123/src/main.js", { method: "POST", body: "body" });
assert.equal(httpServerResponse.statusCode, 200);
assert.equal(httpServerResponse.headers?.["x-cli-server"], "loopback");
assert.equal(httpServerResponse.headers?.["x-cli-values"], "one, two, three");
assert.equal(httpServerResponse.body, "served:POST:/src/main.js");

const workerHttpServerNetwork = createLoopbackNetwork();
const workerHttpServerResult = await createWorkerBackedAsyncCliModuleEvaluator({
  loopbackNetwork: workerHttpServerNetwork,
  root: "/workspace",
  workerFactory: () => new FakeCliEvaluationWorker(),
  workspace: httpServerBridgeWorkspace
})({
  entry: {
    name: "http-server",
    version: "1.0.0",
    entry: "/workspace/http-server/package/bin/server.cjs"
  },
  args: [],
  cwd: "/workspace/project"
});
assert.equal(workerHttpServerResult.stderr, "");
assert.equal(workerHttpServerResult.exitCode, 0);
assert.deepEqual(workerHttpServerResult.bridgedServerPorts, [6123]);
const workerHttpServerResponse = await workerHttpServerNetwork.fetch("http://127.0.0.1:6123/worker.js", { method: "PUT", body: "worker-body" });
assert.equal(workerHttpServerResponse.statusCode, 200);
assert.equal(workerHttpServerResponse.headers?.["x-cli-server"], "loopback");
assert.equal(workerHttpServerResponse.body, "served:PUT:/worker.js");
workerHttpServerResult.closeBridgedServers?.();
await assert.rejects(
  workerHttpServerNetwork.fetch("http://127.0.0.1:6123/worker.js"),
  (error) => error.code === "ECONNREFUSED"
);

const viteClientBridgeWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/vite-client-bridge/package/bin/server.cjs",
    data: `
      const http = require('node:http');
      http.createServer((request, response) => {
        if (request.url === '/@fs//workspace/project/node_modules/vite/dist/client/client.mjs') {
          response.setHeader('content-type', 'text/javascript');
          response.end('export const createHotContext = () => ({ accept() {} });');
          return;
        }
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('');
      }).listen(6124, '127.0.0.1', () => process.stdout.write('listening'));
    `
  },
  {
    path: "/workspace/vite-client-bridge/package/package.json",
    data: JSON.stringify({ name: "vite-client-bridge", version: "1.0.0", bin: { "vite-client-bridge": "bin/server.cjs" } })
  }
]);
const viteClientBridgeNetwork = createLoopbackNetwork();
const viteClientBridgeResult = await createWorkerBackedAsyncCliModuleEvaluator({
  loopbackNetwork: viteClientBridgeNetwork,
  root: "/workspace",
  workerFactory: () => new FakeCliEvaluationWorker(),
  workspace: viteClientBridgeWorkspace
})({
  entry: {
    name: "vite-client-bridge",
    version: "1.0.0",
    entry: "/workspace/vite-client-bridge/package/bin/server.cjs"
  },
  args: [],
  cwd: "/workspace/project"
});
assert.equal(viteClientBridgeResult.exitCode, 0);
const viteClientBridgeResponse = await viteClientBridgeNetwork.fetch("http://127.0.0.1:6124/@vite/client", {
  headers: { "sec-fetch-dest": "script" }
});
assert.equal(viteClientBridgeResponse.statusCode, 200);
assert.match(viteClientBridgeResponse.body, /createHotContext/);
viteClientBridgeResult.closeBridgedServers?.();

const pendingCliWorkspace = new MemoryPackageManagerWorkspace([
  {
    path: "/workspace/pending/package/bin/pending.mjs",
    data: "await new Promise(() => {});\n"
  },
  {
    path: "/workspace/pending/package/package.json",
    data: JSON.stringify({ name: "pending-cli", version: "1.2.3", type: "module", bin: { pending: "bin/pending.mjs" } })
  }
]);
const pendingCliResult = await createAsyncCliModuleEvaluator({
  readyTimeoutMs: 5,
  root: "/workspace",
  reader: pendingCliWorkspace,
  settleTimeoutMs: 1
})({
  entry: {
    name: "pending",
    version: "1.2.3",
    entry: "/workspace/pending/package/bin/pending.mjs",
    mode: "esm"
  },
  args: [],
  cwd: "/workspace/project"
});
assert.equal(pendingCliResult.exitCode, 1);
assert.match(pendingCliResult.stderr, /ECLIETIMEOUT/);

const workerBackedPendingCliResult = await createWorkerBackedAsyncCliModuleEvaluator({
  readyTimeoutMs: 5,
  root: "/workspace",
  workerFactory: () => new FakeCliEvaluationWorker(),
  workspace: pendingCliWorkspace
})({
  entry: {
    name: "pending",
    version: "1.2.3",
    entry: "/workspace/pending/package/bin/pending.mjs",
    mode: "esm"
  },
  args: [],
  cwd: "/workspace/project"
});
assert.equal(workerBackedPendingCliResult.exitCode, 1);
assert.match(workerBackedPendingCliResult.stderr, /ECLIETIMEOUT/);

const nonRespondingWorker = new NonRespondingCliEvaluationWorker();
await assert.rejects(
  () => createWorkerBackedAsyncCliModuleEvaluator({
    root: "/workspace",
    workerFactory: () => nonRespondingWorker,
    workerTimeoutMs: 5,
    workspace: pendingCliWorkspace
  })({
    entry: {
      name: "pending",
      version: "1.2.3",
      entry: "/workspace/pending/package/bin/pending.mjs",
      mode: "esm"
    },
    args: [],
    cwd: "/workspace/project"
  }),
  /ECLIEWORKERTIMEOUT/
);
assert.equal(nonRespondingWorker.terminated, true);

const hangingBridgeWorker = new HangingBridgeCliEvaluationWorker();
const hangingBridgeNetwork = createLoopbackNetwork();
const hangingBridgeResult = await createWorkerBackedAsyncCliModuleEvaluator({
  loopbackNetwork: hangingBridgeNetwork,
  root: "/workspace",
  workerFactory: () => hangingBridgeWorker,
  workerTimeoutMs: 100,
  workspace: pendingCliWorkspace
})({
  entry: {
    name: "pending",
    version: "1.2.3",
    entry: "/workspace/pending/package/bin/pending.mjs",
    mode: "esm"
  },
  args: [],
  cwd: "/workspace/project"
});
const hangingHttpRequest = hangingBridgeNetwork.fetch("http://127.0.0.1:6125/");
const hangingFsWrite = hangingBridgeResult.writeBridgedFile("/workspace/project/src/main.ts", "updated");
await Promise.resolve();
hangingBridgeResult.closeBridgedServers();
await assert.rejects(hangingHttpRequest, /ECLIBRIDGECLOSED/);
await assert.rejects(hangingFsWrite, /ECLIBRIDGECLOSED/);
assert.equal(hangingBridgeWorker.terminated, true);
assert.equal(hangingBridgeNetwork.listeners.size, 0);
await assert.rejects(
  () => hangingBridgeResult.writeBridgedFile("/workspace/project/src/main.ts", "late write"),
  /ECLIBRIDGECLOSED/
);

const crashWorker = new HangingBridgeCliEvaluationWorker();
const crashNetwork = createLoopbackNetwork();
const crashResult = await createWorkerBackedAsyncCliModuleEvaluator({
  loopbackNetwork: crashNetwork,
  root: "/workspace",
  workerFactory: () => crashWorker,
  workspace: pendingCliWorkspace
})({
  entry: { name: "pending", version: "1.2.3", entry: "/workspace/pending/package/bin/pending.mjs", mode: "esm" },
  args: [],
  cwd: "/workspace/project"
});
const interruptedHttp = crashNetwork.fetch("http://127.0.0.1:6125/");
const interruptedWrite = crashResult.writeBridgedFile("/workspace/project/src/main.ts", "update");
await Promise.resolve();
crashWorker.emitError("worker heap limit");
await assert.rejects(interruptedHttp, /ECLIBRIDGECLOSED/);
await assert.rejects(interruptedWrite, /ECLIBRIDGECLOSED/);
assert.equal(crashNetwork.listeners.size, 0);
assert.equal(crashWorker.terminated, true);

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

const asyncExitResult = await createAsyncCliModuleEvaluator({
  exitTimeoutMs: 100,
  root: "/workspace",
  reader: workspace,
  waitForExit: true
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/async-exit-cli/package/bin/npm-cli.js"
  },
  args: [],
  cwd: "/workspace/project"
});
assert.equal(asyncExitResult.stdout, "finished\n");
assert.equal(asyncExitResult.stderr, "");
assert.equal(asyncExitResult.exitCode, 0);

let readTimerOutput = () => ({ stderr: "", stdout: "" });
const timerResult = await createAsyncCliModuleEvaluator({
  onOutputSnapshot(snapshot) {
    readTimerOutput = snapshot;
  },
  root: "/workspace",
  reader: workspace,
  settleTimeoutMs: 5
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/timer-cli/package/bin/npm-cli.js"
  },
  args: [],
  cwd: "/workspace/project"
});
assert.equal(typeof timerResult.dispose, "function");
timerResult.dispose();
const timerOutputAfterDispose = readTimerOutput().stdout;
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(readTimerOutput().stdout, timerOutputAfterDispose);

const errorCauseResult = createCliModuleEvaluator({
  root: "/workspace",
  reader: workspace
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/error-cause-cli/package/bin/npm-cli.js"
  },
  args: [],
  cwd: "/workspace/project"
});
assert.equal(errorCauseResult.stdout, "");
assert.match(errorCauseResult.stderr, /top failure/);
assert.match(errorCauseResult.stderr, /Caused by:/);
assert.match(errorCauseResult.stderr, /nested native binding failure/);
assert.equal(errorCauseResult.exitCode, 1);

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
assert.equal(globalResult.stdout, "function true ok true true true object ok\n");
assert.equal(globalResult.stderr, "");
assert.equal(globalResult.exitCode, 0);

const workerResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: workspace,
  settleTicks: 10,
  settleTimeoutMs: 10
})({
  entry: {
    name: "npm",
    version: "1.2.3",
    entry: "/workspace/worker-cli/package/bin/npm-cli.js"
  },
  args: [],
  cwd: "/workspace/project"
});
assert.equal(workerResult.stdout, "false:wasi:true:object:true\n");
assert.equal(workerResult.stderr, "");
assert.equal(workerResult.exitCode, 0);

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
assert.equal(asyncEsmResult.stdout, "vite esm boot class boot star star createRequire 1.2.3 true mark\n");
assert.equal(asyncEsmResult.stderr, "");
assert.equal(asyncEsmResult.exitCode, 0);

const bundleProcessResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: workspace
})({
  entry: {
    name: "vite",
    version: "1.2.3",
    entry: "/workspace/bundle-process-cli/package/bin/vite.js"
  },
  args: ["--host", "127.0.0.1"],
  cwd: "/workspace/project"
});
assert.equal(bundleProcessResult.stdout, "/workspace/project|/workspace/project|function\n");
assert.equal(bundleProcessResult.stderr, "");
assert.equal(bundleProcessResult.exitCode, 0);

const unawaitedDynamicResult = await createAsyncCliModuleEvaluator({
  root: "/workspace",
  reader: workspace,
  settleTicks: 10
})({
  entry: {
    name: "vite",
    version: "1.2.3",
    entry: "/workspace/unawaited-dynamic-cli/package/bin/vite.js"
  },
  args: [],
  cwd: "/workspace/project"
});
assert.equal(unawaitedDynamicResult.stdout, "");
assert.match(unawaitedDynamicResult.stderr, /ERR_MODULE_NOT_FOUND/);
assert.equal(unawaitedDynamicResult.exitCode, 1);

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
