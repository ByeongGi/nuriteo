import type { JsonRpcMessage, JsonRpcRequest } from "./lspProtocol.ts";
import type { ExtensionCapability } from "./extensionManifest.ts";

const WORKSPACE_TOOLS_COMMAND = "cargo.workspaceTools.hello";

export class ExtensionWorkerServer {
  readonly #send: (message: JsonRpcMessage) => void;
  #active = false;
  #extensionId = "";
  #capabilities = new Set<ExtensionCapability>();

  constructor(send: (message: JsonRpcMessage) => void) {
    this.#send = send;
  }

  receive(message: JsonRpcMessage): "close" | void {
    if (!("method" in message) || !("id" in message)) return;
    if (message.method === "extensionHost/crash") return "close";
    try {
      this.#send({ jsonrpc: "2.0", id: message.id, result: this.#handle(message) });
    } catch (error) {
      this.#send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  #handle(request: JsonRpcRequest): unknown {
    if (request.method === "extensionHost/activate") {
      const params = request.params as { id: string; entrypoint: string; capabilities: ExtensionCapability[] };
      if (params.entrypoint !== "builtin:workspace-tools") throw new Error("Unknown built-in extension entrypoint.");
      this.#extensionId = params.id;
      this.#capabilities = new Set(params.capabilities);
      this.#active = true;
      return {
        extensionId: this.#extensionId,
        contributions: this.#capabilities.has("commands.register") ? { commands: [WORKSPACE_TOOLS_COMMAND] } : {}
      };
    }
    if (request.method === "extensionHost/deactivate") {
      this.#active = false;
      this.#capabilities.clear();
      return { deactivated: true };
    }
    if (request.method === "workspace/executeCommand") {
      if (!this.#active) throw new Error("Extension is not active.");
      if (!this.#capabilities.has("commands.register")) throw new Error("commands.register capability was not granted.");
      const params = request.params as { command: string };
      if (params.command !== WORKSPACE_TOOLS_COMMAND) throw new Error("Extension command is not registered.");
      return { message: "Hello from isolated Workspace Tools", extensionId: this.#extensionId };
    }
    throw new Error(`Unknown extension host method: ${request.method}`);
  }
}
