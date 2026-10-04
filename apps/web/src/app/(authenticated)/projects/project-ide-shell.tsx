"use client";

import type { Project } from "@nuriteo/api-client";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { Button } from "../../../components/ui/button.tsx";
import type {
  RuntimeAdapter,
  RuntimeViewState,
  RuntimeWorkspaceState
} from "../../../runtime/runtime-adapter.ts";

const EMPTY_RUNTIME_STATE: RuntimeViewState = {
  generation: 0,
  lifecycle: "idle",
  projectId: null,
  workflowPhase: "idle",
  previewUrl: null,
  diagnostics: [],
  terminalProcessCount: 0
};
const MAX_TERMINAL_OUTPUT_CHARS = 64 * 1024;
const RUNTIME_BOOT_TIMEOUT_MS = 10_000;
const RUNTIME_RELAY_TIMEOUT_MS = 10_000;
const RUNTIME_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
const CONTENT_HASH = /^[0-9a-f]{64}$/u;

interface Props {
  readonly assetRevision?: string;
  readonly project: Project;
  readonly workspaceScope: string;
}

export function ProjectIdeShell({ assetRevision, project, workspaceScope }: Props) {
  const adapterRef = useRef<RuntimeAdapter | undefined>(undefined);
  const unsubscribeRef = useRef<() => void>(() => undefined);
  const unmountedRef = useRef(false);
  const [workspace, setWorkspace] = useState<RuntimeWorkspaceState>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [editorContent, setEditorContent] = useState("");
  const [terminalOutput, setTerminalOutput] = useState("");
  const [error, setError] = useState<string>();
  const [isStarting, setIsStarting] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeViewState>(EMPTY_RUNTIME_STATE);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      unsubscribeRef.current();
      void adapterRef.current?.dispose();
    };
  }, []);

  async function startWorkspace() {
    if (adapterRef.current !== undefined) {
      setError("Reload this Project before retrying an incompletely released workspace.");
      return;
    }
    if (!assetRevision || !CONTENT_HASH.test(assetRevision)) {
      setError("Runtime assets are not configured for this installation.");
      return;
    }
    setError(undefined);
    setIsStarting(true);
    try {
      const { createRuntimeAdapter } = await import("../../../runtime/runtime-adapter.ts");
      if (unmountedRef.current) return;
      const adapter = createRuntimeAdapter();
      adapterRef.current = adapter;
      unsubscribeRef.current();
      unsubscribeRef.current = adapter.subscribe(setRuntime);
      const origin = globalThis.location.origin;
      const base = `/runtime/${assetRevision}`;
      await adapter.mount({
        project: { id: project.id, localDraftKey: `${workspaceScope}:${project.id}`, displayName: project.name },
        assets: {
          systemWorkerUrl: new URL(`${base}/system-worker.js`, origin),
          processWorkerUrl: new URL(`${base}/process-worker.js`, origin),
          systemWasmUrl: new URL(`${base}/system.wasm`, origin),
          previewServiceWorkerUrl: new URL(`${base}/preview-sw.js`, origin)
        },
        policy: {
          bootTimeoutMs: RUNTIME_BOOT_TIMEOUT_MS,
          relayTimeoutMs: RUNTIME_RELAY_TIMEOUT_MS,
          memoryLimitBytes: RUNTIME_MEMORY_LIMIT_BYTES
        },
        reportDiagnostic(diagnostic) {
          if (diagnostic.severity === "error") setError(diagnostic.message);
        }
      });
      const materialized = await adapter.workspace.materializeTemplate("vite-react");
      const firstTextFile = materialized.files.find((file) => file.kind === "text");
      setWorkspace(materialized);
      if (firstTextFile) selectFile(firstTextFile.path, materialized);
    } catch {
      setError("The browser workspace could not be started safely.");
      await releaseAdapter();
    } finally {
      setIsStarting(false);
    }
  }

  function selectFile(path: string, currentWorkspace = workspace) {
    const file = currentWorkspace?.files.find((candidate) => candidate.path === path);
    if (file?.kind !== "text") {
      setEditorContent("");
      setSelectedPath(path);
      setError("Binary and unsupported files cannot be opened in the text editor.");
      return;
    }
    try {
      const adapter = adapterRef.current;
      if (!adapter) throw new Error("runtime unavailable");
      setEditorContent(adapter.workspace.readText(path));
      setSelectedPath(path);
      setError(undefined);
    } catch {
      setEditorContent("");
      setSelectedPath(path);
      setError("This file cannot be opened as text.");
    }
  }

  async function runCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const command = String(new FormData(form).get("command") ?? "").trim();
    if (!command) return;
    setError(undefined);
    appendTerminal(`$ ${command}\n`);
    try {
      const adapter = adapterRef.current;
      if (!adapter) throw new Error("runtime unavailable");
      await adapter.terminal.run(command, "ide-terminal", (chunk) => appendTerminal(chunk.data));
      form.reset();
    } catch {
      setError("The terminal command did not complete.");
    }
  }

  async function stopWorkspace() {
    const adapter = adapterRef.current;
    await releaseAdapter();
    if (adapter?.getState().lifecycle === "failed") {
      setError("The browser workspace could not release every resource. Reload before retrying.");
      return;
    }
    setWorkspace(undefined);
    setSelectedPath(undefined);
    setEditorContent("");
    setTerminalOutput("");
  }

  async function releaseAdapter() {
    const adapter = adapterRef.current;
    if (!adapter) return;
    await adapter.dispose();
    if (adapter.getState().lifecycle !== "failed") {
      unsubscribeRef.current();
      unsubscribeRef.current = () => undefined;
      adapterRef.current = undefined;
      setRuntime(EMPTY_RUNTIME_STATE);
    }
  }

  function appendTerminal(value: string) {
    setTerminalOutput((current) => `${current}${value}`.slice(-MAX_TERMINAL_OUTPUT_CHARS));
  }

  const hasWorkspace = workspace?.status === "ready";

  return (
    <section className="mt-6 overflow-hidden rounded-lg border border-border bg-surface" aria-labelledby="project-ide-title">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-muted-border bg-subtle px-4 py-3">
        <div><p className="m-0 text-xs text-muted-foreground">Browser workspace · {runtime.lifecycle}</p><h3 id="project-ide-title" className="m-0 text-sm font-semibold">{project.name} IDE</h3></div>
        {hasWorkspace ? <Button type="button" size="sm" onClick={() => void stopWorkspace()}>Stop workspace</Button> : <Button type="button" size="sm" variant="primary" disabled={isStarting || project.state !== "active"} onClick={() => void startWorkspace()}>{isStarting ? "Starting…" : "Start workspace"}</Button>}
      </header>
      {error ? <p className="m-3 rounded-md border border-danger p-3 text-sm text-danger" role="alert">{error}</p> : null}
      {project.state !== "active" ? <p className="m-3 text-sm text-muted-foreground">Restore this Project before starting its workspace.</p> : null}
      {hasWorkspace ? (
        <div className="grid min-h-[34rem] grid-cols-1 lg:grid-cols-[14rem_minmax(0,1fr)_minmax(18rem,0.8fr)]">
          <nav className="border-b border-muted-border bg-sidebar p-3 lg:border-r lg:border-b-0" aria-label="Project files">
            <p className="mb-2 mt-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Files</p>
            <ul className="m-0 grid list-none gap-1 p-0">{workspace.files.map((file) => <li key={file.path}><button type="button" className="w-full rounded-sm px-2 py-1.5 text-left font-mono text-xs hover:bg-hover aria-[current=page]:bg-selected" aria-current={selectedPath === file.path ? "page" : undefined} onClick={() => selectFile(file.path)}>{file.path}</button></li>)}</ul>
          </nav>
          <section className="grid min-w-0 grid-rows-[auto_minmax(16rem,1fr)_auto] border-b border-muted-border lg:border-r lg:border-b-0" aria-label="Text editor">
            <div className="border-b border-muted-border bg-subtle px-3 py-2 font-mono text-xs text-muted-foreground">{selectedPath ?? "Select a file"}</div>
            {selectedPath ? <textarea className="h-full min-h-64 w-full resize-none border-0 bg-surface p-4 font-mono text-sm leading-6 text-foreground outline-none" aria-label={`Editor for ${selectedPath}`} readOnly spellCheck={false} value={editorContent} /> : <p className="p-4 text-sm text-muted-foreground">Choose a text file from the tree.</p>}
            <p className="m-0 border-t border-muted-border px-3 py-2 text-xs text-muted-foreground">Local Draft · {workspace.files.length} files · {workspace.totalBytes} bytes</p>
          </section>
          <div className="grid grid-rows-[minmax(12rem,1fr)_minmax(12rem,1fr)]">
            <section className="border-b border-muted-border p-3" aria-label="Preview"><h4 className="m-0 text-sm font-semibold">Preview</h4><p className="text-sm text-muted-foreground">Preview starts with the install/dev journey in RT-004.</p></section>
            <section className="grid min-h-0 grid-rows-[auto_minmax(8rem,1fr)_auto] bg-background" aria-label="Terminal">
              <h4 className="m-0 border-b border-muted-border px-3 py-2 text-sm font-semibold">Terminal</h4>
              <pre className="m-0 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs" aria-live="polite">{terminalOutput || "Run a bounded browser command."}</pre>
              <form className="flex gap-2 border-t border-muted-border p-2" onSubmit={runCommand}><label className="sr-only" htmlFor={`terminal-command-${project.id}`}>Terminal command</label><input id={`terminal-command-${project.id}`} name="command" className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 font-mono text-sm" autoComplete="off" /><Button type="submit" size="sm">Run</Button></form>
            </section>
          </div>
        </div>
      ) : <div className="p-6"><p className="m-0 text-sm text-muted-foreground">Start an isolated Local Draft to materialize the starter template. No server credential is passed to the browser runtime.</p></div>}
    </section>
  );
}
