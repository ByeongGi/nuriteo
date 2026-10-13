import type { CliRunResult } from "../types.ts";
import type { CliRegistryLike, GuestCli } from "./types.ts";

export function createGuestCli(registry: CliRegistryLike): GuestCli {
  return {
    run(argv: string[]): CliRunResult {
      const [name, ...args] = argv;
      if (!name) {
        return { stdout: "", stderr: "missing CLI name\n", exitCode: 1, entry: "" };
      }
      const entry = registry.resolve(name);
      if (args.length === 1 && args[0] === "--version") {
        const result: CliRunResult = {
          stdout: `${entry.version}\n`,
          stderr: "",
          exitCode: 0,
          entry: entry.entry
        };
        if (entry.entrySha256 !== undefined) result.entrySha256 = entry.entrySha256;
        return result;
      }
      const result: CliRunResult = {
        stdout: "",
        stderr: `${name}: unsupported CLI arguments: ${args.join(" ")}\n`,
        exitCode: 1,
        entry: entry.entry
      };
      if (entry.entrySha256 !== undefined) result.entrySha256 = entry.entrySha256;
      return result;
    }
  };
}
