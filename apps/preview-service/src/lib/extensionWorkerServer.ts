import type { ExtensionCapability } from "./extensionManifest.ts";
import type {
  ExtensionActivationResult,
  ExtensionCommandResult,
  ExtensionDiagnosticsResult,
  ExtensionDocument
} from "./extensionRuntimeProtocol.ts";
import type { JsonRpcMessage, JsonRpcRequest, LspDiagnostic } from "./lspProtocol.ts";

const HELLO_COMMAND = "cargo.workspaceTools.hello";
const SORT_LINES_COMMAND = "cargo.workspaceTools.sortLines";

interface BuiltinImplementation {
  commands?: string[];
  languages?: string[];
}

const IMPLEMENTATIONS: Record<string, BuiltinImplementation> = {
  "builtin:workspace-tools": { commands: [HELLO_COMMAND, SORT_LINES_COMMAND] },
  "builtin:code-health": { languages: ["typescript", "javascript"] }
};

export class ExtensionWorkerServer {
  readonly #send: (message: JsonRpcMessage) => void;
  #active = false;
  #extensionId = "";
  #entrypoint = "";
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
    if (request.method === "extensionHost/activate") return this.#activate(request.params);
    if (request.method === "extensionHost/deactivate") {
      this.#active = false;
      this.#capabilities.clear();
      return { deactivated: true };
    }
    this.#assertActive();
    if (request.method === "workspace/executeCommand") return this.#executeCommand(request.params);
    if (request.method === "languages/provideDiagnostics") return this.#provideDiagnostics(request.params);
    throw new Error(`Unknown extension host method: ${request.method}`);
  }

  #activate(params: unknown): ExtensionActivationResult {
    const activation = params as { id: string; entrypoint: string; capabilities: ExtensionCapability[] };
    const implementation = IMPLEMENTATIONS[activation.entrypoint];
    if (!implementation) throw new Error("Unknown built-in extension entrypoint.");
    this.#extensionId = activation.id;
    this.#entrypoint = activation.entrypoint;
    this.#capabilities = new Set(activation.capabilities);
    this.#active = true;
    return {
      extensionId: this.#extensionId,
      contributions: {
        ...(this.#capabilities.has("commands.register") && implementation.commands
          ? { commands: implementation.commands }
          : {}),
        ...(this.#capabilities.has("languages.diagnostics") && implementation.languages
          ? { languages: implementation.languages }
          : {})
      }
    };
  }

  #executeCommand(params: unknown): ExtensionCommandResult {
    this.#requireCapability("commands.register");
    const request = params as { command: string; document?: ExtensionDocument };
    if (this.#entrypoint !== "builtin:workspace-tools") throw new Error("Extension does not contribute commands.");
    if (request.command === HELLO_COMMAND) {
      return { message: "Hello from isolated Workspace Tools" };
    }
    if (request.command === SORT_LINES_COMMAND) {
      this.#requireCapability("workspace.read");
      this.#requireCapability("workspace.write");
      if (!request.document) throw new Error("Sort Lines requires an active workspace document.");
      const trailingNewline = request.document.text.endsWith("\n") ? "\n" : "";
      const text = request.document.text.replace(/\n$/, "").split("\n").sort((left, right) => left.localeCompare(right)).join("\n") + trailingNewline;
      return { message: `Sorted ${request.document.uri}`, edit: { uri: request.document.uri, text } };
    }
    throw new Error("Extension command is not registered.");
  }

  #provideDiagnostics(params: unknown): ExtensionDiagnosticsResult {
    this.#requireCapability("languages.diagnostics");
    this.#requireCapability("workspace.read");
    if (this.#entrypoint !== "builtin:code-health") throw new Error("Extension does not contribute diagnostics.");
    const document = (params as { document?: ExtensionDocument }).document;
    if (!document) throw new Error("Diagnostics require a workspace document.");
    if (!IMPLEMENTATIONS[this.#entrypoint]?.languages?.includes(document.languageId)) return { diagnostics: [] };
    return { diagnostics: consoleDiagnostics(document.text) };
  }

  #assertActive(): void {
    if (!this.#active) throw new Error("Extension is not active.");
  }

  #requireCapability(capability: ExtensionCapability): void {
    if (!this.#capabilities.has(capability)) throw new Error(`${capability} capability was not granted.`);
  }
}

function consoleDiagnostics(text: string): LspDiagnostic[] {
  const diagnostics: LspDiagnostic[] = [];
  const pattern = /\bconsole\.(?:log|debug)\b/g;
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(0, match.index);
    const lines = before.split("\n");
    const line = lines.length - 1;
    const character = lines.at(-1)?.length ?? 0;
    diagnostics.push({
      range: {
        start: { line, character },
        end: { line, character: character + match[0].length }
      },
      severity: 3,
      code: "cargo-code-health-console",
      source: "cargo-code-health",
      message: "Remove console output before shipping."
    });
  }
  return diagnostics;
}
