import type { ShellOp } from "./types.ts";

export function shellStepRuns(op: ShellOp, previousExitCode: number): boolean {
  switch (op) {
    case "&&":
    case "|":
      return previousExitCode === 0;
    case "||":
      return previousExitCode !== 0;
    case null:
      return true;
    default: {
      const unreachable: never = op;
      return unreachable;
    }
  }
}

export function nextShellAction(
  op: ShellOp,
  previousExitCode: number,
  skipPipeTail: boolean
): { kind: "run" } | { kind: "skip"; skipPipeTail: boolean } {
  if (skipPipeTail && op === "|") return { kind: "skip", skipPipeTail: true };
  if (!shellStepRuns(op, previousExitCode)) {
    return { kind: "skip", skipPipeTail: op === "&&" || op === "||" || op === "|" };
  }
  return { kind: "run" };
}
