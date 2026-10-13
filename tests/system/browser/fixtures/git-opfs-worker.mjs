import { loadOpfsGit } from "/node_modules/wasm-git/lg2_opfs_auto.js";

const EXPECTED_SHA256 = "ec1807f0ad7924bd179f1a864b645d2cd44149ca40cb4492ef9cff7425ab4c83";
const MAX_FILE_BYTES = 16 * 1024 * 1024;
let runtimePromise;

self.addEventListener("message", async (event) => {
  const message = event.data || {};
  try {
    const git = await (runtimePromise ||= createRuntime());
    const response = await execute(git, message);
    self.postMessage({ id: message.id, ok: true, variant: git.variant, artifactSha256: EXPECTED_SHA256, ...response });
  } catch (error) {
    self.postMessage({
      id: message.id,
      ok: false,
      code: error?.code || "EGITWORKER",
      error: safeError(error)
    });
  }
});

async function createRuntime() {
  const response = await fetch("/node_modules/wasm-git/lg2_opfs.wasm", { credentials: "omit", cache: "no-store" });
  if (!response.ok) throw coded("EGITINTEGRITY", "Git OPFS artifact is unavailable");
  const wasm = new Uint8Array(await response.arrayBuffer());
  if (await sha256(wasm) !== EXPECTED_SHA256) throw coded("EGITINTEGRITY", "Git OPFS artifact integrity mismatch");
  const capture = { stdout: [], stderr: [] };
  const print = (line) => capture.stdout.push(String(line));
  const printErr = (line) => capture.stderr.push(String(line));
  const git = await loadOpfsGit({
    variant: "pthreads",
    baseUrl: new URL("/node_modules/wasm-git/", self.location.origin),
    moduleArg: { wasmBinary: wasm, print, printErr },
    moduleOverrides: {
      print,
      printErr
    },
    user: "NURITEO",
    email: "runtime@example.test"
  });
  git.capture = capture;
  return git;
}

async function execute(git, message) {
  const repoName = safeProject(message.projectId);
  const dir = git.repoDir(repoName);
  if (message.action === "init") {
    await git.removeRepo(repoName);
    git.FS.mkdir(dir);
    git._createMountSymlink(repoName);
    git.FS.chdir(dir);
    return runChecked(git, ["init", "."]);
  }
  if (message.action === "remove") {
    await git.removeRepo(repoName);
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  if (!(await git.syncRepo(repoName))) throw coded("EGITREPOSITORY", "Git repository is not initialized");
  validateRepository(git, dir);

  switch (message.action) {
    case "status":
      return runChecked(git, ["status", "--short"]);
    case "write-file": {
      const path = safePath(message.path);
      const contents = String(message.contents ?? "");
      if (new TextEncoder().encode(contents).byteLength > MAX_FILE_BYTES) throw coded("EGITFILELIMIT", "Git project file exceeds the worker limit");
      await git.writeFile(repoName, path, contents);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    case "read-file":
      return { exitCode: 0, stdout: "", stderr: "", contents: git.readFile(repoName, safePath(message.path)) };
    case "add": {
      const path = safePath(message.path);
      if (isSymlink(git.FS, `${dir}/${path}`)) throw coded("EGITSYMLINK", "Git refuses project symlinks");
      return runChecked(git, ["add", path]);
    }
    case "commit": {
      const author = safeAuthor(message.author);
      const commitMessage = safeCommit(message.message);
      git.FS.writeFile("/home/web_user/.gitconfig", `[user]\nname = ${author.name}\nemail = ${author.email}\n`);
      return runChecked(git, ["commit", "-m", commitMessage]);
    }
    case "log": {
      const result = await runChecked(git, ["log", "--oneline", `-${safeLogLimit(message.maxEntries)}`]);
      return { ...result, headOid: resolveHead(git.FS, dir) };
    }
    case "import-symlink":
      safePath(message.path);
      throw coded("EGITSYMLINK", "Git refuses symlink entries during project import");
    case "corrupt-head":
      git.FS.writeFile(`${dir}/.git/HEAD`, "../../outside\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    case "inject-malformed-object": {
      const oid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      try { git.FS.mkdir(`${dir}/.git/objects/aa`); } catch {}
      git.FS.writeFile(`${dir}/.git/objects/aa/${oid.slice(2)}`, "not-a-zlib-git-object");
      return { exitCode: 0, stdout: "", stderr: "", oid };
    }
    case "validate-object":
      return runChecked(git, ["cat-file", "-e", safeOid(message.oid)]);
    default:
      throw coded("EGITACTION", "Unsupported Git OPFS action");
  }
}

function isSymlink(fs, path) {
  try {
    if (fs.isLink(fs.lstat(path).mode)) return true;
  } catch {}
  try {
    fs.readlink(path);
    return true;
  } catch {
    return false;
  }
}

function resolveHead(fs, dir) {
  const head = fs.readFile(`${dir}/.git/HEAD`, { encoding: "utf8" }).trim();
  if (/^[a-f0-9]{40}$/.test(head)) return head;
  const ref = head.replace(/^ref: /, "");
  const oid = fs.readFile(`${dir}/.git/${ref}`, { encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(oid)) throw coded("EGITCORRUPT", "Git HEAD target is malformed");
  return oid;
}

async function runChecked(git, args) {
  const stdout = git.capture.stdout;
  const stderr = git.capture.stderr;
  stdout.length = 0;
  stderr.length = 0;
  let exitCode;
  try {
    exitCode = await git.run(args);
  } catch (error) {
    if (typeof error?.status !== "number") throw error;
    exitCode = error.status;
  }
  const result = {
    exitCode,
    stdout: stdout.length ? `${stdout.join("\n")}\n` : "",
    stderr: stderr.length ? `${stderr.join("\n")}\n` : ""
  };
  if (exitCode !== 0) throw coded("EGITCORRUPT", "Git repository operation failed");
  return result;
}

function validateRepository(git, dir) {
  let head;
  try {
    head = git.FS.readFile(`${dir}/.git/HEAD`, { encoding: "utf8" }).trim();
  } catch {
    throw coded("EGITCORRUPT", "Git repository metadata is unreadable");
  }
  if (!/^ref: refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/.test(head) && !/^[a-f0-9]{40}$/.test(head)) {
    throw coded("EGITCORRUPT", "Git repository metadata is malformed");
  }
}

function safeProject(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value || "")) throw coded("EGITPROJECT", "Invalid Git project ID");
  return `nuriteo-${value}`;
}

function safePath(value) {
  if (!value || value.startsWith("/") || value.includes("\0")) throw coded("EGITPROJECTPATH", "Invalid Git project path");
  const parts = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw coded("EGITPROJECTPATH", "Git path escapes the project");
      parts.pop();
    } else parts.push(part);
  }
  const normalized = parts.join("/");
  const comparable = normalized.toLowerCase();
  if (!normalized || comparable === ".git" || comparable.startsWith(".git/")) throw coded("EGITMETADATA", "Direct Git metadata access is disabled");
  return normalized;
}

function safeAuthor(author) {
  const name = String(author?.name || "").trim();
  const email = String(author?.email || "").trim();
  if (!name || !email || /[\r\n]/.test(`${name}${email}`)) throw coded("EGITAUTHOR", "Invalid Git author");
  return { name, email };
}

function safeCommit(value) {
  const message = String(value || "").trim();
  if (!message || new TextEncoder().encode(message).byteLength > 64 * 1024) throw coded("EGITCOMMIT", "Invalid Git commit message");
  return message;
}

function safeLogLimit(value) {
  const limit = value ?? 20;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) throw coded("EGITLOG", "Invalid Git log limit");
  return limit;
}

function safeOid(value) {
  if (!/^[a-f0-9]{40}$/.test(value || "")) throw coded("EGITOBJECT", "Invalid Git object ID");
  return value;
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error || "Git OPFS operation failed");
  return error?.code ? `${error.code}: ${message}` : `EGITWORKER: ${message}`;
}

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
