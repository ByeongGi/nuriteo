import { useEffect, useRef, useState } from "react";

import { BrowserDebugSession, type DebugSnapshot } from "../lib/browserDebugSession";

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

export function DebuggerPanel({ onError }: { onError: (message: string) => void }) {
  const debuggerRef = useRef<BrowserDebugSession | null>(null);
  const [debugSnapshot, setDebugSnapshot] = useState<DebugSnapshot>(EMPTY_DEBUG_SNAPSHOT);
  const [breakpointCondition, setBreakpointCondition] = useState("counter >= 2");
  const [watchExpression, setWatchExpression] = useState("counter + 1");
  const [consoleExpression, setConsoleExpression] = useState("counter = 7");

  useEffect(() => {
    const debugSession = new BrowserDebugSession();
    debuggerRef.current = debugSession;
    const unsubscribe = debugSession.subscribe(setDebugSnapshot);
    return () => {
      debuggerRef.current = null;
      unsubscribe();
      void debugSession.dispose();
    };
  }, []);

  const runDebugAction = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <section className="min-h-0 flex-1 overflow-auto px-3 py-2">
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
    </section>
  );
}
