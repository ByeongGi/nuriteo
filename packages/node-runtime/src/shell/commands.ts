import type { RuntimeEnv } from "../types.ts";
import type { ShellCommandMap, ShellCommandRegistry } from "./types.ts";

export function createCommandRegistry(commands: ShellCommandMap = {}): ShellCommandRegistry {
  return {
    resolve(name: string, env: RuntimeEnv = {}, cwd = "/workspace") {
      if (commands[name]) return commands[name];
      for (const dir of (env.PATH || "").split(":").filter(Boolean)) {
        const candidate = dir.startsWith("/") ? `${dir}/${name}` : `${cwd}/${dir}/${name}`;
        if (commands[candidate]) return commands[candidate];
      }
      throw Object.assign(new Error(`command not found: ${name}`), { code: 127 });
    }
  };
}

export function shebangCommand(source: string): string[] | null {
  const firstLine = source.split("\n")[0] || "";
  if (!firstLine.startsWith("#!")) return null;
  return firstLine.slice(2).trim().split(/\s+/);
}
