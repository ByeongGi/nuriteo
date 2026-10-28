import { createCliEvaluationHttpBridge, evaluateCliModuleWorkerMessage, MemoryPackageManagerWorkspace } from "../../../packages/node-runtime/src/index.ts";

export class FakeCliEvaluationWorker {
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


export class NonRespondingCliEvaluationWorker {
  terminated = false;

  addEventListener() {}

  removeEventListener() {}

  postMessage() {}

  terminate() {
    this.terminated = true;
  }
}


export class HangingBridgeCliEvaluationWorker {
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


export const workspace = new MemoryPackageManagerWorkspace([
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
