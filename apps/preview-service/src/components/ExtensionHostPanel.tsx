import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";

import type { PreviewControllerModel } from "../hooks/usePreviewController";
import { BrowserExtensionManager, type ExtensionManagerSnapshot } from "../lib/browserExtensionManager";
import { BUILTIN_EXTENSION_MANIFESTS, BUILTIN_WORKSPACE_TOOLS_MANIFEST, type ExtensionCapability } from "../lib/extensionManifest";
import type { ExtensionDocument } from "../lib/extensionRuntimeProtocol";
import { loadExtensionPermissions, saveExtensionPermissions } from "../lib/extensionPermissions";
import type { LspDiagnostic } from "../lib/lspProtocol";
import { monacoModelPath } from "../lib/monacoProjectSync";

const DIAGNOSTIC_OWNER = "cargo-extension-host";
const EMPTY_SNAPSHOT: ExtensionManagerSnapshot = { extensions: [] };

export function ExtensionHostPanel({ model, onError }: { model: PreviewControllerModel; onError: (message: string) => void }) {
  const managerRef = useRef<BrowserExtensionManager | null>(null);
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [message, setMessage] = useState("");
  const [permissions, setPermissions] = useState<Record<string, ExtensionCapability[]>>(() =>
    Object.fromEntries(BUILTIN_EXTENSION_MANIFESTS.map((manifest) => [manifest.id, loadExtensionPermissions(manifest)]))
  );
  const [managerGeneration, setManagerGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const manager = new BrowserExtensionManager(BUILTIN_EXTENSION_MANIFESTS, permissions);
    managerRef.current = manager;
    const unsubscribe = manager.subscribe((next) => {
      if (!cancelled) setSnapshot(next);
    });
    void manager.start().then(
      () => {
        if (!cancelled) setManagerGeneration((value) => value + 1);
      },
      (reason: unknown) => {
        if (!cancelled) onError(errorMessage(reason));
      }
    );
    return () => {
      cancelled = true;
      unsubscribe();
      if (managerRef.current === manager) managerRef.current = null;
      void manager.dispose();
    };
  }, [permissions, onError]);

  const selectedDocument = extensionDocument(model);
  useEffect(() => {
    const manager = managerRef.current;
    if (!manager || !selectedDocument) return;
    let cancelled = false;
    void manager.provideDiagnostics(selectedDocument).then(
      (diagnostics) => {
        if (!cancelled) publishDiagnostics(selectedDocument.uri, diagnostics);
      },
      (reason: unknown) => {
        if (!cancelled) onError(errorMessage(reason));
      }
    );
    return () => {
      cancelled = true;
      publishDiagnostics(selectedDocument.uri, []);
    };
  }, [managerGeneration, onError, selectedDocument?.languageId, selectedDocument?.text, selectedDocument?.uri, selectedDocument?.version]);

  const updatePermission = (extensionId: string, capability: ExtensionCapability, granted: boolean) => {
    const manifest = BUILTIN_EXTENSION_MANIFESTS.find((candidate) => candidate.id === extensionId);
    if (!manifest) return;
    const current = permissions[extensionId] ?? [];
    const next = granted ? [...new Set([...current, capability])] : current.filter((entry) => entry !== capability);
    saveExtensionPermissions(manifest, next);
    setPermissions((state) => ({ ...state, [extensionId]: next }));
  };

  const executeCommand = async (command: string) => {
    const manager = managerRef.current;
    if (!manager) return;
    try {
      const result = await manager.executeCommand(command, selectedDocument ?? undefined);
      if (result.edit) {
        model.editFile(new URL(result.edit.uri).pathname, result.edit.text);
      }
      setMessage(result.message ?? "Command completed.");
    } catch (reason) {
      onError(errorMessage(reason));
    }
  };

  const workspaceStatus = snapshot.extensions.find((extension) => extension.id === BUILTIN_WORKSPACE_TOOLS_MANIFEST.id);
  const workspaceGrants = permissions[BUILTIN_WORKSPACE_TOOLS_MANIFEST.id] ?? [];

  return (
    <section className="border-b border-cargo-line px-3 py-2" aria-label="Isolated extension hosts">
      <p className="text-[11px] font-semibold tracking-wide text-cargo-muted uppercase">Isolated extension hosts</p>
      <div className="mt-1 space-y-1">
        {snapshot.extensions.map((extension) => (
          <p key={extension.id} className="text-sm text-cargo-ink">
            <span className="font-medium">{extension.name}</span> · {extension.state}
            {extension.error ? <span className="text-red-400"> · {extension.error}</span> : null}
          </p>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-cargo-muted">worker-per-extension · signed · integrity pinned · capability brokered</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          id="extension-run-command"
          type="button"
          className="btn-small"
          disabled={workspaceStatus?.state !== "active" || !workspaceGrants.includes("commands.register")}
          onClick={() => void executeCommand("cargo.workspaceTools.hello")}
        >
          Run command
        </button>
        <button
          id="extension-sort-lines"
          type="button"
          className="btn-small btn-ghost"
          disabled={workspaceStatus?.state !== "active" || !selectedDocument || !workspaceGrants.includes("workspace.write")}
          onClick={() => void executeCommand("cargo.workspaceTools.sortLines")}
        >
          Sort lines
        </button>
        <button
          id="extension-crash-recover"
          type="button"
          className="btn-small btn-ghost"
          disabled={workspaceStatus?.state !== "active" || (workspaceStatus?.recoveryCount ?? 0) > 0}
          onClick={() => void managerRef.current?.recover(BUILTIN_WORKSPACE_TOOLS_MANIFEST.id).catch((reason: unknown) => onError(errorMessage(reason)))}
        >
          Crash + recover
        </button>
      </div>
      <div className="mt-2 space-y-2 text-[11px] text-cargo-muted">
        {BUILTIN_EXTENSION_MANIFESTS.map((manifest) => (
          <fieldset key={manifest.id} className="rounded border border-cargo-line p-2">
            <legend className="px-1 font-medium text-cargo-ink">{manifest.id}</legend>
            {manifest.capabilities.map((capability) => (
              <label key={capability} className="flex items-center gap-2">
                <input
                  aria-label={`${manifest.id} ${capability}`}
                  type="checkbox"
                  checked={(permissions[manifest.id] ?? []).includes(capability)}
                  onChange={(event) => updatePermission(manifest.id, capability, event.target.checked)}
                />
                {capability}
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      {message ? <p id="extension-command-result" className="mt-2 text-xs text-cargo-accent-strong">{message}</p> : null}
      <p id="extension-grants" className="mt-2 font-mono text-[10px] text-cargo-muted">
        grants: {workspaceGrants.join(", ") || "none"} · recoveries {workspaceStatus?.recoveryCount ?? 0}/1
      </p>
    </section>
  );
}

function extensionDocument(model: PreviewControllerModel): ExtensionDocument | null {
  if (!model.selectedPath || !model.editorFile) return null;
  const languageId = languageIdForPath(model.selectedPath);
  if (!languageId) return null;
  return {
    uri: monacoModelPath(model.selectedPath),
    languageId,
    text: model.editorFile.data,
    version: model.editorFile.dirty ? 2 : 1
  };
}

function languageIdForPath(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  return null;
}

function publishDiagnostics(uri: string, diagnostics: LspDiagnostic[]): void {
  const model = monaco.editor.getModel(monaco.Uri.parse(uri));
  if (!model) return;
  monaco.editor.setModelMarkers(model, DIAGNOSTIC_OWNER, diagnostics.map((diagnostic) => ({
    startLineNumber: diagnostic.range.start.line + 1,
    startColumn: diagnostic.range.start.character + 1,
    endLineNumber: diagnostic.range.end.line + 1,
    endColumn: diagnostic.range.end.character + 1,
    message: diagnostic.message,
    severity: diagnostic.severity === 1 ? monaco.MarkerSeverity.Error
      : diagnostic.severity === 2 ? monaco.MarkerSeverity.Warning
        : monaco.MarkerSeverity.Info,
    source: diagnostic.source,
    code: diagnostic.code?.toString()
  })));
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
