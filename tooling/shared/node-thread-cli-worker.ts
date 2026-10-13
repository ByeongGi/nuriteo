import { Worker } from "node:worker_threads";

export class NodeThreadCliEvaluationWorker {
  #listeners = {
    error: new Set(),
    message: new Set()
  };
  #worker = new Worker(`
    import { parentPort } from "node:worker_threads";
    import { Worker as NestedWorker } from "node:worker_threads";
    import { createCliEvaluationHttpBridge, evaluateCliModuleWorkerMessage } from ${JSON.stringify(new URL("../../packages/node-runtime/src/package-managers/cli-evaluator.ts", import.meta.url).href)};
    const httpBridges = new Map();
    const webSockets = new Map();
    const nestedWorkers = new Set();
    const createNestedWorker = (request) => {
      const child = new NestedWorker(new URL(${JSON.stringify(new URL("./node-thread-cli-nested-worker.ts", import.meta.url).href)}), {
        workerData: request,
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 256 }
      });
      nestedWorkers.add(child);
      child.on("exit", () => nestedWorkers.delete(child));
      return {
        postMessage: (value) => child.postMessage(value),
        terminate: () => child.terminate(),
        onMessage: (listener) => child.on("message", listener),
        onError: (listener) => child.on("error", listener),
        onExit: (listener) => child.on("exit", listener)
      };
    };
    process.on("exit", () => {
      for (const worker of nestedWorkers) void worker.terminate();
    });
    parentPort.on("message", async (message) => {
      try {
        if (message.type === "cli:http:request") {
          const bridge = httpBridges.get(message.evaluationId);
          if (!bridge) throw new Error("missing CLI HTTP bridge: " + message.evaluationId);
          parentPort.postMessage({
            evaluationId: message.evaluationId,
            id: message.id,
            response: await bridge.handleRequest(message.port, message.request),
            type: "cli:http:response"
          });
          return;
        }
        if (message.type === "cli:fs:write") {
          const bridge = httpBridges.get(message.evaluationId);
          try {
            if (!bridge?.writeFile) throw new Error("missing CLI fs bridge: " + message.evaluationId);
            const result = bridge.writeFile(message.path, message.data);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            parentPort.postMessage({
              evaluationId: message.evaluationId,
              id: message.id,
              result: {
                ...result,
                ...(bridge.getOutput ? { output: bridge.getOutput() } : {})
              },
              type: "cli:fs:write:result"
            });
          } catch (error) {
            parentPort.postMessage({
              error: error instanceof Error ? error.message : String(error),
              evaluationId: message.evaluationId,
              id: message.id,
              type: "cli:fs:write:result"
            });
          }
          return;
        }
        if (message.type === "cli:ws:connect") {
          const bridge = httpBridges.get(message.evaluationId);
          if (!bridge) throw new Error("missing CLI HTTP bridge: " + message.evaluationId);
          const socket = bridge.network.connectWebSocket("ws://127.0.0.1:" + message.port + message.path, {
            headers: message.headers,
            protocol: message.protocol
          });
          webSockets.set(message.evaluationId + ":" + message.id, socket);
          socket.onmessage = (event) => parentPort.postMessage({
            data: event.data,
            evaluationId: message.evaluationId,
            id: message.id,
            type: "cli:ws:message"
          });
          socket.onclose = () => {
            webSockets.delete(message.evaluationId + ":" + message.id);
            parentPort.postMessage({
              evaluationId: message.evaluationId,
              id: message.id,
              type: "cli:ws:close"
            });
          };
          return;
        }
        if (message.type === "cli:ws:message") {
          webSockets.get(message.evaluationId + ":" + message.id)?.send(message.data);
          return;
        }
        if (message.type === "cli:ws:close") {
          const key = message.evaluationId + ":" + message.id;
          webSockets.get(key)?.close();
          webSockets.delete(key);
          return;
        }
        const bridge = message.bridgeLoopbackServer ? createCliEvaluationHttpBridge() : null;
        const response = await evaluateCliModuleWorkerMessage(message, {
          ...(bridge ? { httpBridge: bridge } : {}),
          nestedWorkerFactory: createNestedWorker
        });
        if (bridge && response.result?.bridgedServerPorts?.length) httpBridges.set(message.id, bridge);
        parentPort.postMessage(response);
      } catch (error) {
        parentPort.postMessage({
          error: error instanceof Error ? error.stack || error.message : String(error),
          id: message.id,
          type: "cli:result"
        });
      }
    });
  `, { eval: true, type: "module", resourceLimits: { maxOldGenerationSizeMb: 256 } });

  constructor() {
    this.#worker.on("message", (data) => {
      for (const listener of this.#listeners.message) listener({ data });
    });
    this.#worker.on("error", (error) => {
      for (const listener of this.#listeners.error) listener({ message: error.message });
    });
  }

  addEventListener(type, listener) {
    this.#listeners[type]?.add(listener);
  }

  removeEventListener(type, listener) {
    this.#listeners[type]?.delete(listener);
  }

  postMessage(message) {
    this.#worker.postMessage(message);
  }

  terminate() {
    void this.#worker.terminate();
  }
}
