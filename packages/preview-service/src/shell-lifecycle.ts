import type { ProjectWorkspaceStore } from "../../browser-host/src/storage/index.ts";
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
}

export interface PreviewShellLifecycle {
  cancelShellCommand(terminalId?: string): boolean;
  closeShell(terminalId: string): boolean;
  listShellProcesses(): Array<{ terminalId: string; command: string; cwd: string; status: "running" }>;
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

  const createShell = (terminalId: string): PreviewShellSession => createPreviewShellSession({
    getCwd: options.getCwd,
    getProject: options.getProject,
    onChunk(chunk) {
      options.log(`[${chunk.stream}] ${chunk.data.replace(/\n$/, "")}`);
      outputListeners.get(terminalId)?.(chunk);
    },
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
          stdout: ""
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
    listShellProcesses() {
      const processes: Array<{ terminalId: string; command: string; cwd: string; status: "running" }> = [];
      for (const [terminalId, shell] of shells) {
        const current = shell.session.snapshot();
        if (current.activeEntry) {
          processes.push({
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
