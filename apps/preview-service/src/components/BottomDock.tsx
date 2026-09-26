import { Tabs } from "@base-ui/react/tabs";
import { Plus, X } from "lucide-react";
import type { PreviewControllerModel } from "../hooks/usePreviewController";
import { InteractiveTerminal } from "./InteractiveTerminal";

export function BottomDock({ model }: { model: PreviewControllerModel }) {
  const {
    snapshot,
    dockTab,
    setDockTab,
    runRecoveryAction,
    terminals,
    activeTerminalId,
    setActiveTerminalId,
    addTerminal,
    closeTerminal
  } = model;
  const diagnostics = snapshot.diagnostics;
  const languageProblems = model.languageProblems;
  const problemCount = diagnostics.length + languageProblems.length + (snapshot.lastError ? 1 : 0);

  return (
    <div className="flex h-full min-h-0 flex-col border-t border-cargo-line bg-cargo-elevated/90" data-panel="dock">
      <Tabs.Root
        value={dockTab}
        onValueChange={(value) => setDockTab(value === "diagnostics" ? "diagnostics" : "terminal")}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex items-center gap-1 border-b border-cargo-line px-2">
          <Tabs.List className="flex items-center gap-1 py-1" aria-label="Bottom panels">
            <Tabs.Tab value="terminal" className={({ active }) => `dock-tab${active ? " is-active" : ""}`}>
              Terminal
            </Tabs.Tab>
            <Tabs.Tab value="diagnostics" className={({ active }) => `dock-tab${active ? " is-active" : ""}`}>
              Problems{problemCount > 0 ? ` (${problemCount})` : ""}
            </Tabs.Tab>
          </Tabs.List>
          <div className="flex-1" />
          <p id="terminal-status" className="px-2 text-[11px] text-cargo-muted">
            {snapshot.phase.replaceAll("_", " ")}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <Tabs.Panel value="terminal" className="flex h-full min-h-0 flex-col" id="dock-terminal">
            <div className="flex items-center gap-1 border-b border-cargo-line px-2 py-1">
              {terminals.map((terminal) => (
                <div
                  key={terminal.id}
                  className={`flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] ${
                    activeTerminalId === terminal.id
                      ? "border-cargo-accent/50 bg-cargo-accent/10 text-cargo-accent-strong"
                      : "border-transparent text-cargo-muted hover:bg-cargo-panel-2"
                  }`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTerminalId === terminal.id}
                    onClick={() => setActiveTerminalId(terminal.id)}
                  >
                    {terminal.title}
                  </button>
                  {terminals.length > 1 ? (
                    <button
                      type="button"
                      className="rounded p-0.5 opacity-60 hover:opacity-100"
                      aria-label={`Close ${terminal.title}`}
                      onClick={() => closeTerminal(terminal.id)}
                    >
                      <X className="size-3" />
                    </button>
                  ) : null}
                </div>
              ))}
              <button
                type="button"
                className="icon-btn size-6"
                title="New terminal"
                aria-label="New terminal"
                onClick={() => addTerminal()}
              >
                <Plus className="size-3.5" />
              </button>
            </div>
            <pre id="terminal-log" className="sr-only" aria-hidden="true">
              {snapshot.logs.join("\n")}
            </pre>
            {terminals.map((terminal) => (
              <div key={terminal.id} className={activeTerminalId === terminal.id ? "min-h-0 flex-1" : "hidden"}>
                <InteractiveTerminal model={model} terminalId={terminal.id} active={activeTerminalId === terminal.id} />
              </div>
            ))}
          </Tabs.Panel>

          <Tabs.Panel value="diagnostics" className="flex h-full min-h-0 flex-col" id="dock-diagnostics">
            <div className="flex items-baseline justify-between gap-3 px-3 pt-2 text-xs">
              <p id="diagnostics-status" className="font-medium text-cargo-ink">
                {problemCount > 0 ? (snapshot.phase === "failed" ? "needs attention" : "attention") : "idle"}
              </p>
              <p className="text-cargo-muted">Runtime and language-service diagnostics</p>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-auto p-3 md:grid-cols-2">
              <ol id="diagnostics-user" aria-label="User-facing diagnostics" className="space-y-2">
                {diagnostics.length === 0 && languageProblems.length === 0 && !snapshot.lastError ? (
                  <li className="text-xs text-cargo-muted">No problems reported.</li>
                ) : (
                  <>
                    {languageProblems.map((problem) => (
                      <li key={problem.id}>
                        <button
                          type="button"
                          className="w-full rounded-lg border border-cargo-line bg-cargo-panel px-3 py-2 text-left hover:border-cargo-accent/50"
                          onClick={() => model.openLanguageProblem(problem)}
                        >
                          <span className="flex items-center justify-between gap-2 font-mono text-[10px] tracking-wide uppercase">
                            <span
                              className={
                                problem.severity === "error"
                                  ? "text-red-400"
                                  : problem.severity === "warning"
                                    ? "text-cargo-warn"
                                    : "text-cargo-accent"
                              }
                            >
                              {problem.severity} · {problem.source}
                              {problem.code ? ` ${problem.code}` : ""}
                            </span>
                            <span className="text-cargo-muted">
                              {model.displayPath(problem.path)}:{problem.line}:{problem.column}
                            </span>
                          </span>
                          <span className="mt-1 block text-sm text-cargo-ink">{problem.message}</span>
                        </button>
                      </li>
                    ))}
                    {diagnostics.map((diagnostic, index) => (
                      <li
                        key={`${diagnostic.code || "diag"}-${index}`}
                        className="rounded-lg border border-cargo-line bg-cargo-panel px-3 py-2"
                      >
                        <div className="code font-mono text-[10px] tracking-wide text-cargo-accent uppercase">
                          {diagnostic.code || "DIAG"}
                        </div>
                        <p className="mt-1 text-sm text-cargo-ink">{diagnostic.message}</p>
                        {diagnostic.recoveryActions?.length ? (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {diagnostic.recoveryActions.map((action) => (
                              <button
                                key={`${action.kind}-${action.label}`}
                                type="button"
                                className="btn-small"
                                onClick={() => void runRecoveryAction(action.kind)}
                              >
                                {action.label}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </>
                )}
              </ol>
              <div className="rounded-lg border border-cargo-line bg-cargo-panel p-3">
                <p className="text-[11px] font-semibold tracking-wide text-cargo-muted uppercase">Last error</p>
                <pre
                  id="diagnostics-detail"
                  className="mt-2 overflow-auto font-mono text-[11px] leading-relaxed text-cargo-ink/90"
                >
                  {snapshot.lastError
                    ? `${snapshot.lastError.source}: ${snapshot.lastError.message}${snapshot.lastError.stack ? `\n${snapshot.lastError.stack}` : ""}`
                    : "No runtime error captured."}
                </pre>
              </div>
            </div>
          </Tabs.Panel>
        </div>
      </Tabs.Root>
    </div>
  );
}
