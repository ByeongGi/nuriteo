import { useEffect, useRef, useState } from "react";
import { BrowserDebugSession, type DebugSnapshot } from "../lib/browserDebugSession";
import { BrowserExtensionHost, type ExtensionHostState } from "../lib/browserExtensionHost";
import { BUILTIN_WORKSPACE_TOOLS_MANIFEST } from "../lib/extensionManifest";
import type { ExtensionCapability } from "../lib/extensionManifest";
import { loadExtensionPermissions, saveExtensionPermissions } from "../lib/extensionPermissions";

const EMPTY_DEBUG_SNAPSHOT: DebugSnapshot = {
  state: "stopped",
  reason: null,
  line: null,
  stack: [],
  scopes: [],
  variables: [],
  watches: [],
  console: []
};

export function DeveloperToolsPanel() {
  const extensionRef = useRef<BrowserExtensionHost | null>(null);
  const debuggerRef = useRef<BrowserDebugSession | null>(null);
  const [extensionState, setExtensionState] = useState<ExtensionHostState>("stopped");
  const [extensionMessage, setExtensionMessage] = useState("");
  const [recoveryCount, setRecoveryCount] = useState(0);
  const [permissionGrants, setPermissionGrants] = useState<ExtensionCapability[]>(() =>
    loadExtensionPermissions(BUILTIN_WORKSPACE_TOOLS_MANIFEST)
  );
  const [debugSnapshot, setDebugSnapshot] = useState<DebugSnapshot>(EMPTY_DEBUG_SNAPSHOT);
  const [breakpointCondition, setBreakpointCondition] = useState("counter >= 2");
  const [watchExpression, setWatchExpression] = useState("counter + 1");
  const [consoleExpression, setConsoleExpression] = useState("counter = 7");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const extension = new BrowserExtensionHost(BUILTIN_WORKSPACE_TOOLS_MANIFEST, permissionGrants);
    const debugSession = new BrowserDebugSession();
    extensionRef.current = extension;
    debuggerRef.current = debugSession;
    const unsubscribe = debugSession.subscribe(setDebugSnapshot);
    setExtensionState("verifying");
    void extension.activate().then(
      () => {
        if (!cancelled) setExtensionState(extension.state);
      },
      (reason: unknown) => {
        if (cancelled) return;
        setExtensionState("failed");
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    );
    return () => {
      cancelled = true;
      extensionRef.current = null;
      debuggerRef.current = null;
      unsubscribe();
      void extension.deactivate();
      void debugSession.dispose();
    };
  }, []);

  const updatePermission = async (capability: ExtensionCapability, granted: boolean) => {
    const next = granted
      ? [...new Set([...permissionGrants, capability])]
      : permissionGrants.filter((entry) => entry !== capability);
    setPermissionGrants(next);
    saveExtensionPermissions(BUILTIN_WORKSPACE_TOOLS_MANIFEST, next);
    const previous = extensionRef.current;
    extensionRef.current = null;
    await previous?.deactivate();
    const replacement = new BrowserExtensionHost(BUILTIN_WORKSPACE_TOOLS_MANIFEST, next);
    extensionRef.current = replacement;
    setExtensionState("verifying");
    try {
      await replacement.activate();
      if (extensionRef.current === replacement) setExtensionState(replacement.state);
    } catch (reason) {
      setExtensionState("failed");
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const runExtensionCommand = async () => {
    const extension = extensionRef.current;
    if (!extension) return;
    try {
      setExtensionMessage(await extension.executeHelloCommand());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const crashAndRecover = async () => {
    const extension = extensionRef.current;
    if (!extension) return;
    try {
      setExtensionState("recovering");
      await extension.simulateCrashAndRecover();
      setExtensionState(extension.state);
      setRecoveryCount(extension.recoveryCount);
    } catch (reason) {
      setExtensionState("failed");
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const runDebugAction = async (action: () => Promise<void>) => {
    try {
      setError("");
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <aside className="flex h-full min-h-0 flex-col bg-cargo-elevated/80" aria-label="Run and Extensions">
      <div className="border-b border-cargo-line px-3 py-2">
        <p className="text-[11px] font-semibold tracking-wide text-cargo-muted uppercase">Isolated extension host</p>
        <p id="extension-host-status" className="mt-1 text-sm text-cargo-ink">Workspace Tools · {extensionState}</p>
        <p className="mt-1 text-[11px] text-cargo-muted">signed · integrity pinned · no ambient network/filesystem/secrets</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button id="extension-run-command" type="button" className="btn-small" disabled={extensionState !== "active" || !permissionGrants.includes("commands.register")} onClick={() => void runExtensionCommand()}>
            Run command
          </button>
          <button id="extension-crash-recover" type="button" className="btn-small btn-ghost" disabled={extensionState !== "active" || recoveryCount > 0} onClick={() => void crashAndRecover()}>
            Crash + recover
          </button>
        </div>
        <fieldset className="mt-2 space-y-1 text-[11px] text-cargo-muted">
          <legend className="font-medium text-cargo-ink">Persistent permissions</legend>
          {BUILTIN_WORKSPACE_TOOLS_MANIFEST.capabilities.map((capability) => (
            <label key={capability} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={permissionGrants.includes(capability)}
                onChange={(event) => void updatePermission(capability, event.target.checked)}
              />
              {capability}
            </label>
          ))}
        </fieldset>
        {extensionMessage ? <p id="extension-command-result" className="mt-2 text-xs text-cargo-accent-strong">{extensionMessage}</p> : null}
        <p id="extension-grants" className="mt-2 font-mono text-[10px] text-cargo-muted">grants: {permissionGrants.join(", ") || "none"} · recoveries {recoveryCount}/1</p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        <p className="text-[11px] font-semibold tracking-wide text-cargo-muted uppercase">DAP fixture debugger</p>
        <p id="debug-session-status" className="mt-1 text-sm text-cargo-ink">
          {debugSnapshot.state}{debugSnapshot.reason ? ` · ${debugSnapshot.reason}` : ""}{debugSnapshot.line ? ` · line ${debugSnapshot.line}` : ""}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button id="debug-start" type="button" className="btn-small" onClick={() => void runDebugAction(() => debuggerRef.current?.start({ breakpointLine: 3, condition: breakpointCondition }) || Promise.resolve())}>Start</button>
          <button id="debug-continue" type="button" className="btn-small btn-ghost" disabled={debugSnapshot.state !== "paused"} onClick={() => void runDebugAction(() => debuggerRef.current?.continue() || Promise.resolve())}>Continue</button>
          <button id="debug-step" type="button" className="btn-small btn-ghost" disabled={debugSnapshot.state !== "paused"} onClick={() => void runDebugAction(() => debuggerRef.current?.step("next") || Promise.resolve())}>Step over</button>
          <button id="debug-terminate" type="button" className="btn-small btn-ghost" disabled={!['paused', 'running'].includes(debugSnapshot.state)} onClick={() => void runDebugAction(() => debuggerRef.current?.terminate() || Promise.resolve())}>Terminate</button>
        </div>
        <label className="mt-2 block text-[11px] text-cargo-muted">
          Breakpoint condition
          <input id="debug-condition" className="field mt-1 w-full" value={breakpointCondition} onChange={(event) => setBreakpointCondition(event.target.value)} />
        </label>
        <div className="mt-3 space-y-2 font-mono text-[11px]">
          <section>
            <p className="text-cargo-muted">Call stack</p>
            <p id="debug-stack" className="text-cargo-ink">{debugSnapshot.stack.join(", ") || "—"}</p>
          </section>
          <section>
            <p className="text-cargo-muted">Watch</p>
            <div className="mt-1 flex gap-1">
              <input id="debug-watch-input" className="field min-w-0 flex-1" value={watchExpression} onChange={(event) => setWatchExpression(event.target.value)} />
              <button id="debug-watch" type="button" className="btn-small" disabled={debugSnapshot.state !== "paused"} onClick={() => void runDebugAction(() => debuggerRef.current?.evaluateWatch(watchExpression) || Promise.resolve())}>Add</button>
            </div>
            <p id="debug-watches" className="text-cargo-ink">{debugSnapshot.watches.map((watch) => `${watch.expression}=${watch.value}`).join(", ") || "—"}</p>
          </section>
          <section>
            <p className="text-cargo-muted">Debug console</p>
            <div className="mt-1 flex gap-1">
              <input id="debug-console-input" className="field min-w-0 flex-1" value={consoleExpression} onChange={(event) => setConsoleExpression(event.target.value)} />
              <button id="debug-console-run" type="button" className="btn-small" disabled={debugSnapshot.state !== "paused"} onClick={() => void runDebugAction(() => debuggerRef.current?.evaluateConsole(consoleExpression) || Promise.resolve())}>Run</button>
            </div>
            <pre id="debug-console-output" className="mt-1 whitespace-pre-wrap text-cargo-ink">{debugSnapshot.console.join("\n") || "—"}</pre>
          </section>
          <section>
            <p className="text-cargo-muted">Scopes</p>
            <p id="debug-scopes" className="text-cargo-ink">{debugSnapshot.scopes.join(", ") || "—"}</p>
          </section>
          <section>
            <p className="text-cargo-muted">Variables</p>
            <p id="debug-variables" className="text-cargo-ink">{debugSnapshot.variables.map((variable) => `${variable.name}=${variable.value}`).join(", ") || "—"}</p>
          </section>
        </div>
        {error ? <p id="developer-tools-error" className="mt-3 text-xs text-red-400">{error}</p> : null}
      </div>
    </aside>
  );
}
