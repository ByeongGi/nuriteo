import type {
  HostProcessShellCommand,
  HostProcessShellCommandOptions,
  HostProcessShellCommandResult
} from "./types.ts";

export function createHostProcessShellCommand(options: HostProcessShellCommandOptions): HostProcessShellCommand {
  return async ({ argv, cwd, env, stdin, output, signal, terminal }): Promise<HostProcessShellCommandResult> => {
    const prepared = options.table.prepare({
      argv,
      cwd: options.cwd || cwd,
      env,
      ...(options.terminalMode ? { terminalMode: options.terminalMode } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {}),
      url: options.url
    });
    const unsubscribe = options.table.subscribeOutput((chunk) => {
      if (chunk.pid !== prepared.pid || chunk.generation !== prepared.generation) return;
      output?.({ stream: chunk.stream, data: chunk.data });
    });
    const stopInput = terminal?.onInput((data) => options.table.writeStdin(prepared.pid, data)) || (() => undefined);
    const stopResize = terminal?.onResize((size) => options.table.resize(prepared.pid, size)) || (() => undefined);
    const abort = () => {
      const reason = signal?.reason;
      options.table.signal(
        prepared.pid,
        reason === "SIGINT" || reason === "SIGTERM" || reason === "SIGKILL" ? reason : "SIGKILL"
      );
    };
    signal?.addEventListener("abort", abort, { once: true });

    try {
      const started = await options.table.start(prepared.pid);
      if (terminal && started.status === "ready") options.table.resize(prepared.pid, terminal.size);
      if (stdin) options.table.writeStdin(prepared.pid, stdin);
      const final = options.waitForExit === false || started.status !== "ready"
        ? started
        : await options.table.wait(prepared.pid);
      return {
        argv: [...argv],
        exitCode: final.exitCode ?? 0,
        stderr: final.stderr || (final.error ? `${final.error}\n` : ""),
        stdout: final.stdout,
        ...(final.outputDroppedBytes > 0 ? { outputTruncatedBytes: final.outputDroppedBytes } : {})
      };
    } finally {
      signal?.removeEventListener("abort", abort);
      stopInput();
      stopResize();
      unsubscribe();
      if (options.releaseOnExit) options.table.release(prepared.pid);
    }
  };
}
