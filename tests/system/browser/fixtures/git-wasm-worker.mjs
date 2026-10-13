import initGit from "/node_modules/wasm-git/lg2.js";

const EXPECTED_SHA256 = "5cd5df122c066f63c1a940e66fb126a0a35f44b7c0f1c9801b1c1007078eb0f9";

self.addEventListener("message", async (event) => {
  const { id } = event.data || {};
  try {
    const startedAt = performance.now();
    const response = await fetch("/node_modules/wasm-git/lg2.wasm", { credentials: "omit", cache: "no-store" });
    if (!response.ok) throw new Error(`Git WASM fetch failed: ${response.status}`);
    const wasm = new Uint8Array(await response.arrayBuffer());
    const hash = await sha256(wasm);
    if (hash !== EXPECTED_SHA256) throw new Error(`Git WASM integrity mismatch: ${hash}`);

    const snapshot = new Map([["message.txt", new TextEncoder().encode("browser git\n")]]);
    const first = await createRuntime(wasm, snapshot);
    const init = first.run(["init", "."]);
    const before = first.run(["status", "--short"]);
    first.run(["add", "message.txt"]);
    const commit = first.run(["commit", "-m", "browser fixture"]);
    const clean = first.run(["status", "--short"]);
    const log = first.run(["log", "--oneline", "-1"]);
    first.persist(snapshot);

    const reopened = await createRuntime(wasm, snapshot);
    const reopenedStatus = reopened.run(["status", "--short"]);
    const reopenedLog = reopened.run(["log", "--oneline", "-1"]);
    self.postMessage({
      id,
      ok: true,
      hash,
      bytes: wasm.byteLength,
      elapsedMs: performance.now() - startedAt,
      init,
      before,
      commit,
      clean,
      log,
      reopenedStatus,
      reopenedLog,
      persistedHead: snapshot.has(".git/HEAD"),
      persistedIndex: snapshot.has(".git/index")
    });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

async function createRuntime(wasm, snapshot) {
  let stdout = [];
  let stderr = [];
  const module = await initGit({
    noInitialRun: true,
    wasmBinary: wasm,
    print: (line) => stdout.push(String(line)),
    printErr: (line) => stderr.push(String(line))
  });
  const fs = module.FS;
  mkdirRecursive(fs, "/home/web_user");
  fs.writeFile("/home/web_user/.gitconfig", "[user]\nname = Browser Fixture\nemail = browser@example.test\n");
  mkdirRecursive(fs, "/project");
  for (const [path, bytes] of snapshot) {
    const target = `/project/${path}`;
    mkdirRecursive(fs, target.slice(0, target.lastIndexOf("/")) || "/project");
    fs.writeFile(target, bytes);
  }
  fs.chdir("/project");
  return {
    run(args) {
      stdout = [];
      stderr = [];
      let exitCode;
      try {
        exitCode = module.callMain(args);
      } catch (error) {
        if (typeof error?.status !== "number") throw error;
        exitCode = error.status;
      }
      return {
        exitCode,
        stdout: stdout.length ? `${stdout.join("\n")}\n` : "",
        stderr: stderr.length ? `${stderr.join("\n")}\n` : ""
      };
    },
    persist(output) {
      output.clear();
      collectFiles(fs, "/project", "", output);
    }
  };
}

function collectFiles(fs, root, relativeRoot, output) {
  const directory = relativeRoot ? `${root}/${relativeRoot}` : root;
  for (const name of fs.readdir(directory)) {
    if (name === "." || name === "..") continue;
    const relativePath = relativeRoot ? `${relativeRoot}/${name}` : name;
    const absolutePath = `${root}/${relativePath}`;
    const stat = fs.stat(absolutePath);
    if (fs.isDir(stat.mode)) collectFiles(fs, root, relativePath, output);
    else output.set(relativePath, fs.readFile(absolutePath));
  }
}

function mkdirRecursive(fs, path) {
  if (!path || path === "/") return;
  const parent = path.slice(0, path.lastIndexOf("/")) || "/";
  mkdirRecursive(fs, parent);
  try {
    fs.mkdir(path);
  } catch (error) {
    if (error?.errno !== 20) throw error;
  }
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
