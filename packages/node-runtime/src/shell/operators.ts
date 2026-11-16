import type { ShellOp } from "./types.ts";

export function shellStepRuns(op: ShellOp, previousExitCode: number): boolean {
  switch (op) {
    case "&&":
      return previousExitCode === 0;
    case "||":
      return previousExitCode !== 0;
    case "|":
    case null:
      return true;
    default: {
      const unreachable: never = op;
      return unreachable;
    }
  }
}

export function shellChainContinues(exitCode: number, nextOp: ShellOp | undefined): boolean {
  if (exitCode === 0) return true;
  return nextOp === "&&" || nextOp === "||";
}
