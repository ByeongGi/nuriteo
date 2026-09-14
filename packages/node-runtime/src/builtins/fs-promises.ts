import type { RuntimeFsBinding, RuntimeFsData } from "../types.ts";

export interface FsPromisesBuiltin {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  lstat(path: string): Promise<ReturnType<RuntimeFsBinding["statSync"]>>;
  readFile(path: string, options?: "utf8" | "utf-8" | { encoding?: "utf8" | "utf-8" | null }): Promise<string | Uint8Array>;
  rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
  rmdir(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<ReturnType<RuntimeFsBinding["statSync"]>>;
  symlink(target: string, path: string, type?: string): Promise<void>;
  unlink(path: string): Promise<void>;
  utimes(path: string, atime: Date | number | string, mtime: Date | number | string): Promise<void>;
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

    async rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> {
      removeSync(fs, path, options);
    },

    async rmdir(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> {
      removeSync(fs, path, options);
    },

    async stat(path: string): Promise<ReturnType<RuntimeFsBinding["statSync"]>> {
      return fs.statSync(path);
    },

    async symlink(target: string, path: string, type?: string): Promise<void> {
      const maybeSymlinkSync = (fs as RuntimeFsBinding & {
        symlinkSync?: (target: string, path: string, type?: string) => void;
      }).symlinkSync;
      if (!maybeSymlinkSync) throw new Error("fs.symlink is not supported by this binding");
      maybeSymlinkSync(target, path, type);
    },

    async unlink(path: string): Promise<void> {
      removeSync(fs, path);
    },

    async utimes(path: string, atime: Date | number | string, mtime: Date | number | string): Promise<void> {
      const maybeUtimesSync = (fs as RuntimeFsBinding & {
        utimesSync?: (path: string, atime: Date | number | string, mtime: Date | number | string) => void;
      }).utimesSync;
      if (maybeUtimesSync) {
        maybeUtimesSync(path, atime, mtime);
        return;
      }
      fs.statSync(path);
    },

    async writeFile(path: string, data: RuntimeFsData): Promise<void> {
      fs.writeFileSync(path, data);
    }
  });
}

function removeSync(fs: RuntimeFsBinding, path: string, options: { force?: boolean; recursive?: boolean } = {}): void {
  const maybeRmSync = (fs as RuntimeFsBinding & {
    rmSync?: (path: string, options?: { force?: boolean; recursive?: boolean }) => void;
  }).rmSync;
  if (maybeRmSync) {
    maybeRmSync(path, options);
    return;
  }
  if (options.force) return;
  throw new Error("fs.rm is not supported by this binding");
}
