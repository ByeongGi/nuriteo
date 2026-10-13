let latestSequence = 0;

navigator.serviceWorker.addEventListener("message", (event) => {
  const message = event.data;
  if (!isExactRecord(message, ["binding", "generation", "path", "sequence", "type", "version"])) return;
  const binding = location.hostname.split(".")[0] ?? "";
  if (message.type !== "nuriteo-preview:hmr"
      || message.version !== 1
      || message.binding !== binding
      || message.generation !== /^r-([a-z2-7]{45})-p[1-9][0-9]{0,4}$/.exec(binding)?.[1]
      || typeof message.path !== "string"
      || !/^src\/(?!.*\.\.)[^\\]{1,508}$/.test(message.path)
      || !Number.isSafeInteger(message.sequence)
      || message.sequence <= latestSequence) return;
  latestSequence = message.sequence;
  void applyUpdate(message.sequence, message.path);
});

async function applyUpdate(sequence, path) {
  try {
    await import(`/src/main.tsx?nuriteo_hmr=${sequence}`);
    globalThis.dispatchEvent(new CustomEvent("nuriteo-preview:hmr-applied", { detail: { path, sequence } }));
  } catch {
    // The current document remains usable; the parent owns recovery UX.
  }
}

function isExactRecord(value, keys) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}
