import type {
  HostProcessShellCommand,
  HostProcessShellCommandOptions,
  HostProcessShellCommandResult
} from "./types.ts";

export function createHostProcessShellCommand(options: HostProcessShellCommandOptions): HostProcessShellCommand {
  return async ({ argv, cwd, env, stdin, output, signal }): Promise<HostProcessShellCommandResult> => {
    const prepared = options.table.prepare({
      cwd: options.cwd || cwd,
      env,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      url: options.url
    });
    const unsubscribe = options.table.subscribeOutput((chunk) => {
      if (chunk.pid !== prepared.pid || chunk.generation !== prepared.generation) return;
      output?.({ stream: chunk.stream, data: chunk.data });
    });
    const abort = () => {
      options.table.kill(prepared.pid);
    };
    signal?.addEventListener("abort", abort, { once: true });

    try {
      const started = await options.table.start(prepared.pid);
      if (stdin) options.table.writeStdin(prepared.pid, stdin);
      const final = options.waitForExit === false || started.status !== "ready"
        ? started
        : await options.table.wait(prepared.pid);
      return {
        argv: [...argv],
        exitCode: final.exitCode ?? 0,
        stderr: final.stderr,
        stdout: final.stdout
      };
    } finally {
      signal?.removeEventListener("abort", abort);
      unsubscribe();
    }
  };
}
