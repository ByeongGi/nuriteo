import type { RuntimeFsBinding, RuntimeFsData } from "../types.ts";

export interface FsPromisesBuiltin {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  lstat(path: string): Promise<ReturnType<RuntimeFsBinding["statSync"]>>;
  readFile(path: string, options?: "utf8" | "utf-8" | { encoding?: "utf8" | "utf-8" | null }): Promise<string | Uint8Array>;
  stat(path: string): Promise<ReturnType<RuntimeFsBinding["statSync"]>>;
  writeFile(path: string, data: RuntimeFsData): Promise<void>;
}

export function createFsPromisesBuiltin(fs: RuntimeFsBinding): FsPromisesBuiltin {
  return Object.freeze({
    async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
      fs.mkdirSync(path);
    },

    async lstat(path: string): Promise<ReturnType<RuntimeFsBinding["statSync"]>> {
      return fs.lstatSync ? fs.lstatSync(path) : fs.statSync(path);
    },

    async readFile(
      path: string,
      options?: "utf8" | "utf-8" | { encoding?: "utf8" | "utf-8" | null }
    ): Promise<string | Uint8Array> {
      const encoding = typeof options === "string" ? options : options?.encoding;
      return encoding ? fs.readFileSync(path, encoding) : fs.readFileSync(path);
    },

    async stat(path: string): Promise<ReturnType<RuntimeFsBinding["statSync"]>> {
      return fs.statSync(path);
    },

    async writeFile(path: string, data: RuntimeFsData): Promise<void> {
      fs.writeFileSync(path, data);
    }
  });
}
