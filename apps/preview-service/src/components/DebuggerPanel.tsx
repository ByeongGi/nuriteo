import { useEffect, useMemo, useRef, useState } from "react";

import type { PreviewControllerModel } from "../hooks/usePreviewController";
import { BrowserDebugSession, type DebugSnapshot } from "../lib/browserDebugSession";
import { loadDebugBreakpoints, saveDebugBreakpoints } from "../lib/debugConfiguration";
import { monacoModelPath } from "../lib/monacoProjectSync";

const EMPTY_DEBUG_SNAPSHOT: DebugSnapshot = {
  state: "stopped",
  reason: null,
  line: null,
  stack: [],
  scopes: [],
  variables: [],
  watches: [],
  console: [],
  sourceUri: null
};

export function DebuggerPanel({ model, onError }: { model: PreviewControllerModel; onError: (message: string) => void }) {
  const debuggerRef = useRef<BrowserDebugSession | null>(null);
  const [debugSnapshot, setDebugSnapshot] = useState<DebugSnapshot>(EMPTY_DEBUG_SNAPSHOT);
  const [targetPath, setTargetPath] = useState("");
  const [breakpointLine, setBreakpointLine] = useState(3);
  const [breakpointCondition, setBreakpointCondition] = useState("counter >= 1");
  const [watchExpression, setWatchExpression] = useState("counter + 1");
  const [consoleExpression, setConsoleExpression] = useState("counter = 7");
  const debugFiles = useMemo(
    () => (model.snapshot.project?.listFiles() ?? []).filter((file) => /\.[cm]?[jt]sx?$/.test(file.path)),
    [model.snapshot]
  );

  useEffect(() => {
    if (targetPath && debugFiles.some((file) => file.path === targetPath)) return;
    const preferred = debugFiles.find((file) => file.path.endsWith("/src/debug.ts"))
      ?? debugFiles.find((file) => file.path === model.selectedPath)
      ?? debugFiles[0];
    selectTarget(preferred?.path ?? "");
  }, [debugFiles, model.selectedPath, targetPath]);

  const selectTarget = (path: string) => {
    setTargetPath(path);
    const saved = loadDebugBreakpoints(monacoModelPath(path))[0];
    setBreakpointLine(saved?.line ?? 3);
    setBreakpointCondition(saved?.condition ?? "counter >= 1");
  };

  const updateBreakpoint = (line: number, condition: string) => {
    setBreakpointLine(line);
    setBreakpointCondition(condition);
    if (targetPath) saveDebugBreakpoints(monacoModelPath(targetPath), [{ line, ...(condition.trim() ? { condition: condition.trim() } : {}) }]);
  };

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

  const start = async () => {
    const target = debugFiles.find((file) => file.path === targetPath);
    if (!target) throw new Error("Select a TypeScript or JavaScript workspace file to debug.");
    const open = model.snapshot.editor?.openFile(target.path);
    await debuggerRef.current?.start({
      program: monacoModelPath(target.path),
      source: open?.data ?? target.data,
      breakpoints: [{ line: breakpointLine, ...(breakpointCondition.trim() ? { condition: breakpointCondition.trim() } : {}) }]
    });
  };

  return (
    <section className="min-h-0 flex-1 overflow-auto px-3 py-2">
      <p className="text-[11px] font-semibold tracking-wide text-cargo-muted uppercase">Browser workspace debugger · DAP</p>
      <p id="debug-session-status" className="mt-1 text-sm text-cargo-ink">
        {debugSnapshot.state}{debugSnapshot.reason ? ` · ${debugSnapshot.reason}` : ""}{debugSnapshot.line ? ` · line ${debugSnapshot.line}` : ""}
      </p>
      <label className="mt-2 block text-[11px] text-cargo-muted">
        Program
        <select id="debug-program" className="field mt-1 w-full" value={targetPath} onChange={(event) => selectTarget(event.target.value)}>
          {debugFiles.map((file) => <option key={file.path} value={file.path}>{model.displayPath(file.path)}</option>)}
        </select>
      </label>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button id="debug-start" type="button" className="btn-small" disabled={!targetPath} onClick={() => void runDebugAction(start)}>Start</button>
        <button id="debug-continue" type="button" className="btn-small btn-ghost" disabled={debugSnapshot.state !== "paused"} onClick={() => void runDebugAction(() => debuggerRef.current?.continue() || Promise.resolve())}>Continue</button>
        <button id="debug-step" type="button" className="btn-small btn-ghost" disabled={debugSnapshot.state !== "paused"} onClick={() => void runDebugAction(() => debuggerRef.current?.step("next") || Promise.resolve())}>Step over</button>
        <button id="debug-terminate" type="button" className="btn-small btn-ghost" disabled={!['paused', 'running'].includes(debugSnapshot.state)} onClick={() => void runDebugAction(() => debuggerRef.current?.terminate() || Promise.resolve())}>Terminate</button>
      </div>
      <div className="mt-2 grid grid-cols-[5rem_1fr] gap-2">
        <label className="block text-[11px] text-cargo-muted">
          Line
          <input id="debug-line" type="number" min={1} className="field mt-1 w-full" value={breakpointLine} onChange={(event) => updateBreakpoint(Math.max(1, Number(event.target.value) || 1), breakpointCondition)} />
        </label>
        <label className="block text-[11px] text-cargo-muted">
          Condition
          <input id="debug-condition" className="field mt-1 w-full" value={breakpointCondition} onChange={(event) => updateBreakpoint(breakpointLine, event.target.value)} />
        </label>
      </div>
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
