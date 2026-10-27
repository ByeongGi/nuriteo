let latestSequence = 0;

navigator.serviceWorker.addEventListener("message", (event) => {
  const message = event.data;
  if (!isExactRecord(message, ["binding", "changeKind", "generation", "path", "sequence", "type", "version"])) return;
  const binding = location.hostname.split(".")[0] ?? "";
  if (message.type !== "nuriteo-preview:hmr"
      || message.version !== 1
      || message.binding !== binding
      || !["content", "create", "delete", "rename"].includes(message.changeKind)
      || message.generation !== /^r-([a-z2-7]{45})-p[1-9][0-9]{0,4}$/.exec(binding)?.[1]
      || typeof message.path !== "string"
      || !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0]{1,512}$/.test(message.path)
      || !Number.isSafeInteger(message.sequence)
      || message.sequence <= latestSequence) return;
  latestSequence = message.sequence;
  void applyUpdate(message.sequence, message.path, message.changeKind);
});

async function applyUpdate(sequence, path, changeKind) {
  try {
    if (changeKind !== "content") {
      reloadPreview();
      return;
    }
    if (/\.css$/iu.test(path)) {
      await replaceStylesheet(path, sequence);
      dispatchAppliedUpdate("stylesheet", path, sequence);
      return;
    }
    if (/\.(?:[cm]?[jt]sx?)$/iu.test(path)) {
      await reloadModuleGraph(sequence);
      dispatchAppliedUpdate("module", path, sequence);
      return;
    }
    reloadPreview();
  } catch {
    reloadPreview();
  }
}

async function replaceStylesheet(path, sequence) {
  const expectedPathname = new URL(`/${path}`, location.origin).pathname;
  const stylesheets = [...document.querySelectorAll('link[rel~="stylesheet"][href]')]
    .filter((link) => new URL(link.href, location.href).pathname === expectedPathname);
  if (stylesheets.length === 0) throw new Error("The changed stylesheet is not active in this document");
  await Promise.all(stylesheets.map((stylesheet) => swapStylesheet(stylesheet, sequence)));
}

async function swapStylesheet(stylesheet, sequence) {
  const replacement = stylesheet.cloneNode(false);
  const versionedUrl = new URL(stylesheet.href, location.href);
  versionedUrl.searchParams.set("nuriteo_hmr", String(sequence));
  replacement.href = versionedUrl.href;
  replacement.removeAttribute("integrity");
  await new Promise((resolve, reject) => {
    replacement.addEventListener("load", resolve, { once: true });
    replacement.addEventListener("error", reject, { once: true });
    stylesheet.parentNode?.insertBefore(replacement, stylesheet.nextSibling);
  });
  stylesheet.remove();
}

async function reloadModuleGraph(sequence) {
  const entryScript = [...document.querySelectorAll('script[type="module"][src]')]
    .find((script) => isSupportedModuleEntry(new URL(script.src, location.href).pathname));
  if (!entryScript) throw new Error("Preview module entry was not found");
  const versionedUrl = new URL(entryScript.src, location.href);
  versionedUrl.searchParams.set("nuriteo_hmr", String(sequence));
  await import(versionedUrl.href);
}

function isSupportedModuleEntry(pathname) {
  return pathname.startsWith("/")
    && !pathname.startsWith("/runtime-preview/")
    && !pathname.startsWith("/node_modules/");
}

function dispatchAppliedUpdate(mode, path, sequence) {
  globalThis.dispatchEvent(new CustomEvent("nuriteo-preview:hmr-applied", { detail: { mode, path, sequence } }));
}

function reloadPreview() {
  location.reload();
}

function isExactRecord(value, keys) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}
