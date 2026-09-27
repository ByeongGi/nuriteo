import type { RuntimeFsBinding, RuntimeFsData } from "../types.ts";

export interface FsPromisesBuiltin {
  access(path: string, mode?: number): Promise<void>;
  appendFile(path: string, data: RuntimeFsData): Promise<void>;
  chmod(path: string, mode: number | string): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  copyFile(source: string, target: string): Promise<void>;
  fchmod(fd: number, mode: number | string): Promise<void>;
  fchown(fd: number, uid: number, gid: number): Promise<void>;
  fsync(fd: number): Promise<void>;
  link(source: string, target: string): Promise<void>;
  lchmod(path: string, mode: number | string): Promise<void>;
  lchown(path: string, uid: number, gid: number): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  lstat(path: string): Promise<ReturnType<RuntimeFsBinding["statSync"]>>;
  open(path: string, flags?: string | number): Promise<FsPromisesFileHandle>;
  opendir(path: string): Promise<unknown>;
  readFile(path: string, options?: "utf8" | "utf-8" | { encoding?: "utf8" | "utf-8" | null }): Promise<string | Uint8Array>;
  readlink(path: string): Promise<string>;
  readdir(path: string, options?: { withFileTypes?: boolean }): Promise<unknown[]>;
  rename(source: string, target: string): Promise<void>;
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
    async access(path: string, _mode?: number): Promise<void> {
      const maybeAccessSync = (fs as RuntimeFsBinding & { accessSync?: (path: string, mode?: number) => void }).accessSync;
      if (maybeAccessSync) maybeAccessSync(path, _mode);
      else fs.statSync(path);
    },

    async appendFile(path: string, data: RuntimeFsData): Promise<void> {
      const maybeAppendFileSync = (fs as RuntimeFsBinding & {
        appendFileSync?: (path: string, data: RuntimeFsData) => void;
      }).appendFileSync;
      if (!maybeAppendFileSync) throw new Error("fs.appendFile is not supported by this binding");
      maybeAppendFileSync(path, data);
    },

    async chmod(path: string, mode: number | string): Promise<void> {
      callMetadataSync(fs, "chmodSync", [path, mode], () => fs.statSync(path));
    },

    async chown(path: string, uid: number, gid: number): Promise<void> {
      callMetadataSync(fs, "chownSync", [path, uid, gid], () => fs.statSync(path));
    },

    async copyFile(source: string, target: string): Promise<void> {
      const maybeCopyFileSync = (fs as RuntimeFsBinding & {
        copyFileSync?: (source: string, target: string) => void;
      }).copyFileSync;
      if (!maybeCopyFileSync) throw new Error("fs.copyFile is not supported by this binding");
      maybeCopyFileSync(source, target);
    },

    async fchmod(fd: number, mode: number | string): Promise<void> {
      callMetadataSync(fs, "fchmodSync", [fd, mode], () => fs.readSync(fd, 0));
    },

    async fchown(fd: number, uid: number, gid: number): Promise<void> {
      callMetadataSync(fs, "fchownSync", [fd, uid, gid], () => fs.readSync(fd, 0));
    },

    async fsync(fd: number): Promise<void> {
      callMetadataSync(fs, "fsyncSync", [fd], () => fs.readSync(fd, 0));
    },

    async link(source: string, target: string): Promise<void> {
      const maybeLinkSync = (fs as RuntimeFsBinding & {
        linkSync?: (source: string, target: string) => void;
      }).linkSync;
      if (!maybeLinkSync) throw new Error("fs.link is not supported by this binding");
      maybeLinkSync(source, target);
    },

    async lchmod(path: string, mode: number | string): Promise<void> {
      callMetadataSync(fs, "lchmodSync", [path, mode], () => fs.lstatSync ? fs.lstatSync(path) : fs.statSync(path));
    },

    async lchown(path: string, uid: number, gid: number): Promise<void> {
      callMetadataSync(fs, "lchownSync", [path, uid, gid], () => fs.lstatSync ? fs.lstatSync(path) : fs.statSync(path));
    },

    async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
      fs.mkdirSync(path);
    },

    async mkdtemp(prefix: string): Promise<string> {
      const maybeMkdtempSync = fs.mkdtempSync;
      if (maybeMkdtempSync) return maybeMkdtempSync(prefix);
      const path = `${prefix}${Math.random().toString(36).slice(2, 8)}`;
      fs.mkdirSync(path);
      return path;
    },

    async lstat(path: string): Promise<ReturnType<RuntimeFsBinding["statSync"]>> {
      return fs.lstatSync ? fs.lstatSync(path) : fs.statSync(path);
    },

    async open(path: string, flags: string | number = "r"): Promise<FsPromisesFileHandle> {
      return createFsPromisesFileHandle(fs.openSync(path, flags), fs);
    },

    async opendir(path: string): Promise<unknown> {
      const maybeOpendirSync = (fs as RuntimeFsBinding & {
        opendirSync?: (path: string) => unknown;
      }).opendirSync;
      if (!maybeOpendirSync) throw new Error("fs.opendir is not supported by this binding");
      return maybeOpendirSync(path);
    },

    async readFile(
      path: string,
      options?: "utf8" | "utf-8" | { encoding?: "utf8" | "utf-8" | null }
    ): Promise<string | Uint8Array> {
      const encoding = typeof options === "string" ? options : options?.encoding;
      return encoding ? fs.readFileSync(path, encoding) : fs.readFileSync(path);
    },

    async readlink(path: string): Promise<string> {
      const maybeReadlinkSync = (fs as RuntimeFsBinding & {
        readlinkSync?: (path: string) => string;
      }).readlinkSync;
      if (!maybeReadlinkSync) throw new Error("fs.readlink is not supported by this binding");
      return maybeReadlinkSync(path);
    },

    async readdir(path: string, options?: { withFileTypes?: boolean }): Promise<unknown[]> {
      const maybeReaddirSync = (fs as RuntimeFsBinding & {
        readdirSync?: (path: string, options?: { withFileTypes?: boolean }) => unknown[];
      }).readdirSync;
      if (!maybeReaddirSync) throw new Error("fs.readdir is not supported by this binding");
      return maybeReaddirSync(path, options);
    },

    async rename(source: string, target: string): Promise<void> {
      const maybeRenameSync = (fs as RuntimeFsBinding & {
        renameSync?: (source: string, target: string) => void;
      }).renameSync;
      if (!maybeRenameSync) throw new Error("fs.rename is not supported by this binding");
      maybeRenameSync(source, target);
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

function createFsPromisesFileHandle(fd: number, fs: RuntimeFsBinding): FsPromisesFileHandle {
  return {
    fd,
    async chmod(mode: number | string): Promise<void> {
      callMetadataSync(fs, "fchmodSync", [fd, mode], () => fs.readSync(fd, 0));
    },
    async chown(uid: number, gid: number): Promise<void> {
      callMetadataSync(fs, "fchownSync", [fd, uid, gid], () => fs.readSync(fd, 0));
    },
    async close(): Promise<void> {
      fs.closeSync(fd);
    },
    async sync(): Promise<void> {
      callMetadataSync(fs, "fsyncSync", [fd], () => fs.readSync(fd, 0));
    },
    async read(
      buffer: Uint8Array,
      offset = 0,
      length = buffer.byteLength - offset,
      position: number | null = 0
    ): Promise<{ bytesRead: number; buffer: Uint8Array }> {
      const bytes = fs.readSync(fd).slice(position ?? 0, (position ?? 0) + length);
      buffer.set(bytes, offset);
      return { bytesRead: bytes.byteLength, buffer };
    },
    async write(data: RuntimeFsData): Promise<{ bytesWritten: number; buffer: RuntimeFsData }> {
      return { bytesWritten: fs.writeSync(fd, data), buffer: data };
    }
  };
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

function callMetadataSync(
  fs: RuntimeFsBinding,
  method: string,
  args: readonly unknown[],
  assertTargetExists: () => unknown
): void {
  const maybeMethod = (fs as RuntimeFsBinding & Record<string, unknown>)[method];
  if (typeof maybeMethod === "function") {
    maybeMethod.apply(fs, args);
    return;
  }
  assertTargetExists();
}

export interface FsPromisesFileHandle {
  fd: number;
  chmod(mode: number | string): Promise<void>;
  chown(uid: number, gid: number): Promise<void>;
  close(): Promise<void>;
  read(
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null
  ): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  sync(): Promise<void>;
  write(data: RuntimeFsData): Promise<{ bytesWritten: number; buffer: RuntimeFsData }>;
}
