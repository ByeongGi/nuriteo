import type { ProjectWorkspaceStore } from "../../browser-host/src/storage/index.ts";
import {
  createHostProcessShellCommand,
  type HostProcessStatus,
  type HostProcessTable
} from "../../browser-host/src/process/index.ts";
import type { TerminalRunResult } from "../../node-runtime/src/shell/index.ts";
import { createPreviewShellSession, type PreviewShellSession } from "./shell.ts";

type ShellOutputChunk = { stream: "stdout" | "stderr"; data: string };

interface ShellCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface PreviewShellLifecycleOptions {
  getCwd(): string;
  getProject(): ProjectWorkspaceStore | null;
  install(): Promise<ShellCommandResult>;
  log(line: unknown): void;
  onProcessFinish(command: string, exitCode: number): void;
  onProcessStart(terminalId: string, command: string): void;
  restartDev(): Promise<ShellCommandResult>;
  runBuild(): Promise<ShellCommandResult>;
  runDev(): Promise<ShellCommandResult>;
  terminalProcessTable?: HostProcessTable | null;
}

type PreviewShellProcess = {
  pid: number;
  generation?: number;
  terminalId: string;
  command: string;
  argv?: string[];
  cwd: string;
  status: "running" | HostProcessStatus;
  terminalMode?: { canonical: boolean; echo: boolean; signals: boolean };
  terminalSize?: { cols: number; rows: number };
};

export interface PreviewShellLifecycle {
  cancelShellCommand(terminalId?: string): boolean;
  closeShell(terminalId: string): boolean;
  dispose(): void;
  listShellProcesses(): PreviewShellProcess[];
  resizeShell(cols: number, rows: number, terminalId?: string): void;
  runShellCommand(
    command: string,
    terminalId?: string,
    onOutput?: (chunk: ShellOutputChunk) => void
  ): Promise<TerminalRunResult>;
  signalShell(signal?: "SIGINT" | "SIGTERM" | "SIGKILL", terminalId?: string): boolean;
  writeShellInput(data: string, terminalId?: string): boolean;
}

export function createPreviewShellLifecycle(
  options: PreviewShellLifecycleOptions
): PreviewShellLifecycle {
  const outputListeners = new Map<string, (chunk: ShellOutputChunk) => void>();
  const shells = new Map<string, PreviewShellSession>();
  const terminalProcessTable = options.terminalProcessTable || null;

  const createShell = (terminalId: string): PreviewShellSession => createPreviewShellSession({
    getCwd: options.getCwd,
    getProject: options.getProject,
    onChunk(chunk) {
      options.log(`[${chunk.stream}] ${chunk.data.replace(/\n$/, "")}`);
      outputListeners.get(terminalId)?.(chunk);
    },
    ...(terminalProcessTable ? {
      processCommands: createTerminalProcessCommands(terminalProcessTable, terminalId)
    } : {}),
    install: options.install,
    runDev: options.runDev,
    runBuild: options.runBuild,
    restartDev: options.restartDev
  });

  function shellFor(terminalId = "default"): PreviewShellSession {
    const existing = shells.get(terminalId);
    if (existing) return existing;
    const shell = createShell(terminalId);
    shells.set(terminalId, shell);
    return shell;
  }

  async function runShellCommand(
    command: string,
    terminalId = "default",
    onOutput?: (chunk: ShellOutputChunk) => void
  ): Promise<TerminalRunResult> {
    const trimmed = command.trim();
    if (!trimmed) {
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        files: {},
        entry: {
          id: 0,
          command: "",
          cwd: options.getCwd(),
          exitCode: 0,
          finishedAt: Date.now(),
          startedAt: Date.now(),
          status: "completed",
          stderr: "",
          stdout: "",
          outputTruncatedBytes: 0
        }
      };
    }

    options.log(`$ ${trimmed}`);
    try {
      if (onOutput) outputListeners.set(terminalId, onOutput);
      const pending = shellFor(terminalId).run(trimmed);
      options.onProcessStart(terminalId, trimmed);
      const result = await pending;
      options.onProcessFinish(trimmed, result.exitCode);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.log(`shell error: ${message}`);
      throw error;
    } finally {
      if (onOutput) outputListeners.delete(terminalId);
    }
  }

  return {
    cancelShellCommand(terminalId = "default") {
      return shellFor(terminalId).cancel();
    },
    closeShell(terminalId) {
      const shell = shells.get(terminalId);
      if (!shell) return false;
      shell.session.kill();
      outputListeners.delete(terminalId);
      return shells.delete(terminalId);
    },
    dispose() {
      for (const terminalId of [...shells.keys()]) {
        const shell = shells.get(terminalId);
        shell?.session.kill();
        outputListeners.delete(terminalId);
        shells.delete(terminalId);
      }
      terminalProcessTable?.teardown();
    },
    listShellProcesses() {
      const processes: PreviewShellProcess[] = [];
      const workerTerminals = new Set<string>();
      for (const process of terminalProcessTable?.list({ activeOnly: true }) || []) {
        const terminalId = process.projectId || "default";
        workerTerminals.add(terminalId);
        processes.push({
          pid: process.pid,
          generation: process.generation,
          terminalId,
          command: process.argv.join(" "),
          argv: [...process.argv],
          cwd: process.cwd,
          status: process.status,
          terminalMode: { ...process.terminalMode },
          terminalSize: { ...process.terminalSize }
        });
      }
      for (const [terminalId, shell] of shells) {
        const current = shell.session.snapshot();
        if (current.activeEntry && !workerTerminals.has(terminalId)) {
          processes.push({
            pid: current.activeEntry.id,
            terminalId,
            command: current.activeEntry.command,
            cwd: current.cwd,
            status: "running"
          });
        }
      }
      return processes;
    },
    resizeShell(cols, rows, terminalId = "default") {
      shellFor(terminalId).session.resize(cols, rows);
    },
    runShellCommand,
    signalShell(signal = "SIGTERM", terminalId = "default") {
      return shellFor(terminalId).session.signal(signal);
    },
    writeShellInput(data, terminalId = "default") {
      return shellFor(terminalId).session.write(data);
    }
  };
}

function createTerminalProcessCommands(table: HostProcessTable, terminalId: string) {
  const command = createHostProcessShellCommand({
    table,
    projectId: terminalId,
    releaseOnExit: true,
    url: "worker://nuriteo/process-worker"
  });
  const ptyCommand = createHostProcessShellCommand({
    table,
    projectId: terminalId,
    releaseOnExit: true,
    terminalMode: { canonical: true, echo: true, signals: true },
    url: "worker://nuriteo/process-worker"
  });
  return {
    "worker-cat": (context: Parameters<typeof command>[0]) => command({ ...context, argv: ["cat", ...context.argv.slice(1)] }),
    "worker-env": (context: Parameters<typeof command>[0]) => command({ ...context, argv: ["env", ...context.argv.slice(1)] }),
    "worker-pty": (context: Parameters<typeof ptyCommand>[0]) => ptyCommand({ ...context, argv: ["cat", ...context.argv.slice(1)] }),
    "worker-pwd": (context: Parameters<typeof command>[0]) => command({ ...context, argv: ["pwd", ...context.argv.slice(1)] }),
    "worker-tty": (context: Parameters<typeof command>[0]) => command({ ...context, argv: ["terminal-size", ...context.argv.slice(1)] })
  };
}
