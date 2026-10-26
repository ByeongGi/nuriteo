(() => {
  const MAX_MESSAGE = 2000;
  const MAX_STACK = 4000;
  const MAX_EVENTS = 100;
  if (window.__nuriteoPreviewConsole) return;
  window.__nuriteoPreviewConsole = true;
  let sent = 0;
  let lastKey = "";
  let lastAt = 0;

  function clip(value, max) {
    const text = typeof value === "string" ? value : String(value ?? "");
    return text.length > max ? text.slice(0, max) : text;
  }

  function formatValue(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.message;
    if (typeof value === "undefined") return "undefined";
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function emit(message, stack) {
    const clippedMessage = clip(message, MAX_MESSAGE).trim();
    const clippedStack = clip(stack, MAX_STACK);
    if (!clippedMessage || sent >= MAX_EVENTS) return;
    const key = `${clippedMessage}\n${clippedStack}`;
    const now = Date.now();
    if (key === lastKey && now - lastAt < 50) return;
    lastKey = key;
    lastAt = now;
    sent += 1;
    window.parent.postMessage({
      level: "error",
      message: clippedMessage,
      stack: clippedStack,
      type: "nuriteo-preview:console",
      version: 1
    }, window.location.origin);
    if (sent === MAX_EVENTS) {
      sent += 1;
      window.parent.postMessage({
        level: "error",
        message: "미리보기 콘솔 에러가 너무 많아 이후 항목은 생략합니다.",
        stack: "",
        type: "nuriteo-preview:console",
        version: 1
      }, window.location.origin);
    }
  }

  window.addEventListener("error", (event) => {
    const error = event?.error;
    if (error instanceof Error) emit(error.message, error.stack || "");
    else emit(event?.message || "Script error", "");
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event?.reason;
    if (reason instanceof Error) emit(reason.message, reason.stack || "");
    else emit(formatValue(reason), "");
  });

  const original = console.error.bind(console);
  console.error = (...args) => {
    try { original(...args); } catch { /* keep collecting after a broken console sink */ }
    const error = args.find((arg) => arg instanceof Error);
    emit(args.map(formatValue).join(" "), error instanceof Error ? error.stack || "" : "");
  };
})();
