"use client";

import type { Project } from "@nuriteo/api-client";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { Button } from "../../../components/ui/button.tsx";
import { createBrowserApiClient } from "../../../lib/api/browser-client.ts";
import { readCsrfCredential } from "../../../lib/api/browser-security.ts";
import { createRetryableLazyFeature } from "../../../lib/retryable-lazy-feature.ts";
import type {
  RuntimeAdapter,
  RuntimeRecoveryActionKind,
  RuntimeViewState,
  RuntimeWorkspaceState
} from "../../../runtime/runtime-adapter.ts";
import { resolveRuntimeAssetRevision } from "../../../runtime/runtime-assets.ts";
import { awaitWorkspaceStart } from "../../../runtime/workspace-start.ts";
import { createSubdomainPreviewBridge } from "../../../runtime/subdomain-preview-bridge.ts";
import type { PreviewOriginConfiguration } from "../../../runtime/preview-origin-contract.ts";
import type { SubdomainPreviewBridge } from "../../../runtime/subdomain-preview-bridge.ts";
import { ProjectHistoryPanel } from "./project-history-panel.tsx";
import type { RestoredProjectHead } from "./project-history-panel.tsx";

const EMPTY_RUNTIME_STATE: RuntimeViewState = {
  generation: 0,
  lifecycle: "idle",
  projectId: null,
  workflowPhase: "idle",
  hmrState: "idle",
  previewUrl: null,
  diagnostics: [],
  localDraftAccess: "none",
  terminalProcessCount: 0
};
const MAX_TERMINAL_OUTPUT_CHARS = 64 * 1024;
const MAX_TERMINAL_COMMAND_CHARS = 2_048;
const RUNTIME_BOOT_TIMEOUT_MS = 10_000;
const RUNTIME_RELAY_TIMEOUT_MS = 10_000;
const RUNTIME_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;

type RuntimeFeature = typeof import("../../../runtime/runtime-adapter.ts");
const runtimeFeature = createRetryableLazyFeature<RuntimeFeature>(
  () => import("../../../runtime/runtime-adapter.ts")
);
type ResumeFeature = typeof import("../../../resume/project-content.ts");
const resumeFeature = createRetryableLazyFeature<ResumeFeature>(
  () => import("../../../resume/project-content.ts")
);
type SaveFeature = typeof import("../../../save/project-save.ts");
const saveFeature = createRetryableLazyFeature<SaveFeature>(() => import("../../../save/project-save.ts"));
type WorkspaceSource = "saved" | "template";

interface Props {
  readonly assetRevision?: string;
  readonly previewConfiguration: PreviewOriginConfiguration;
  readonly previewBridgeFactory?: typeof createSubdomainPreviewBridge;
  readonly project: Project;
  readonly projectEtag?: string;
  readonly onProjectCommit?: (result: { readonly projectEtag: string; readonly projectVersion: number }) => void;
  readonly onProjectReload?: () => void;
  readonly resumeProjectContentLoader?: () => Promise<Pick<ResumeFeature, "resumeProjectContent">>;
  readonly runtimeFeatureLoader?: () => Promise<RuntimeFeature>;
  readonly workspaceScope: string;
}

export function ProjectIdeShell({ assetRevision, onProjectCommit, onProjectReload, previewBridgeFactory, previewConfiguration, project, projectEtag, resumeProjectContentLoader, runtimeFeatureLoader, workspaceScope }: Props) {
  const adapterRef = useRef<RuntimeAdapter | undefined>(undefined);
  const previewBridgeRef = useRef<SubdomainPreviewBridge | undefined>(undefined);
  const previewBridgeOperationRef = useRef(0);
  const previewRecoveryRef = useRef<Promise<void> | null>(null);
  const unsubscribeRef = useRef<() => void>(() => undefined);
  const manifestAbortRef = useRef<AbortController | null>(null);
  const saveAbortRef = useRef<AbortController | null>(null);
  const replacementAbortRef = useRef<AbortController | null>(null);
  const projectEtagRef = useRef(projectEtag);
  const unmountedRef = useRef(false);
  const [workspace, setWorkspace] = useState<RuntimeWorkspaceState>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [editorContent, setEditorContent] = useState("");
  const [terminalOutput, setTerminalOutput] = useState("");
  const [error, setError] = useState<string>();
  const [isStarting, setIsStarting] = useState(false);
  const [startingSource, setStartingSource] = useState<WorkspaceSource>();
  const [resumeStatus, setResumeStatus] = useState<string>();
  const [isRunningPreview, setIsRunningPreview] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isServerSaving, setIsServerSaving] = useState(false);
  const [isReplacingDraft, setIsReplacingDraft] = useState(false);
  const [serverSaveStatus, setServerSaveStatus] = useState("Not saved to server in this session");
  const [serverSaveFailure, setServerSaveFailure] = useState<"retry" | "stale">();
  const [recoveringAction, setRecoveringAction] = useState<RuntimeRecoveryActionKind>();
  const [confirmingWriterTakeover, setConfirmingWriterTakeover] = useState(false);
  const [isolatedPreviewUrl, setIsolatedPreviewUrl] = useState<string>();
  const [editorStatus, setEditorStatus] = useState("Local Draft");
  const [runtime, setRuntime] = useState<RuntimeViewState>(EMPTY_RUNTIME_STATE);
  projectEtagRef.current = projectEtag;

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      previewBridgeOperationRef.current += 1;
      manifestAbortRef.current?.abort();
      saveAbortRef.current?.abort();
      replacementAbortRef.current?.abort();
      unsubscribeRef.current();
      const bridge = previewBridgeRef.current;
      previewBridgeRef.current = undefined;
      void bridge?.dispose();
      void adapterRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    const saveShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveToServer();
      }
    };
    globalThis.addEventListener("keydown", saveShortcut);
    return () => globalThis.removeEventListener("keydown", saveShortcut);
  });

  async function startWorkspace(source: WorkspaceSource) {
    if (adapterRef.current !== undefined) {
      setError("Reload this Project before retrying an incompletely released workspace.");
      return;
    }
    setError(undefined);
    setServerSaveFailure(undefined);
    setIsStarting(true);
    setStartingSource(source);
    setResumeStatus(source === "saved" ? "Checking the current Server Save…" : "Preparing a new Local Draft…");
    try {
      manifestAbortRef.current?.abort();
      const manifestAbort = new AbortController();
      manifestAbortRef.current = manifestAbort;
      const runtimePromise = runtimeFeatureLoader?.() ?? runtimeFeature.load();
      const revisionPromise = resolveRuntimeAssetRevision(assetRevision, manifestAbort.signal);
      const savedContentPromise = source === "saved"
        ? (resumeProjectContentLoader?.() ?? resumeFeature.load()).then(({ resumeProjectContent }) => resumeProjectContent({
            ownerType: project.ownerType,
            ownerId: project.ownerId,
            projectId: project.id,
            storageScopeId: project.storageScopeId
          }, { signal: manifestAbort.signal }))
        : Promise.resolve(undefined);
      const [{ createRuntimeAdapter }, revision, savedContent] = await awaitWorkspaceStart(manifestAbort, {
        runtime: runtimePromise,
        revision: revisionPromise,
        content: savedContentPromise
      });
      if (unmountedRef.current) return;
      setResumeStatus(source === "saved" ? "Verified. Materializing the saved Project…" : "Materializing the starter template…");
      const adapter = createRuntimeAdapter();
      adapterRef.current = adapter;
      unsubscribeRef.current();
      unsubscribeRef.current = adapter.subscribe(setRuntime);
      const origin = globalThis.location.origin;
      const base = `/runtime/${revision}`;
      await adapter.mount({
        project: {
          id: project.id,
          storageScopeId: project.storageScopeId,
          workspaceScopeId: workspaceScope,
          displayName: project.name
        },
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
      const materialized = savedContent === undefined
        ? await adapter.workspace.materializeTemplate("vite-react")
        : await adapter.workspace.materializeBundle(savedContent.files);
      const firstTextFile = materialized.files.find((file) => file.kind === "text");
      setWorkspace(materialized);
      setEditorStatus(savedContent === undefined
        ? "Local Draft"
        : `Server Save v${savedContent.descriptor.projectVersion} restored`);
      setResumeStatus(savedContent === undefined
        ? "Starter template is ready in this browser."
        : `Server Save v${savedContent.descriptor.projectVersion} is ready in this browser.`);
      if (firstTextFile) selectFile(firstTextFile.path, materialized);
    } catch (caught) {
      const contentCode = projectContentErrorCode(caught);
      const runtimeCode = runtimeErrorCode(caught);
      setError(contentCode === null
        ? `The browser workspace could not be started safely.${runtimeCode ? ` (${runtimeCode})` : ""}`
        : resumeErrorMessage(contentCode));
      setResumeStatus(undefined);
      await releaseAdapter();
    } finally {
      manifestAbortRef.current = null;
      setIsStarting(false);
      setStartingSource(undefined);
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
    if (command.length > MAX_TERMINAL_COMMAND_CHARS) {
      setError("The terminal command is too long.");
      return;
    }
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

  async function runPreview() {
    const adapter = adapterRef.current;
    if (!adapter) return;
    if (previewConfiguration.status === "disabled") {
      setError(previewConfiguration.message);
      return;
    }
    setError(undefined);
    setIsRunningPreview(true);
    try {
      const next = await adapter.workflow.start();
      if (!next.previewUrl) throw new Error("Preview URL unavailable");
      await swapPreviewBridge(adapter, next.previewUrl);
    } catch {
      if (!unmountedRef.current && adapterRef.current === adapter) {
        setError("The install and Preview journey did not complete.");
      }
    } finally {
      if (!unmountedRef.current) setIsRunningPreview(false);
    }
  }

  async function executeRecovery(kind: RuntimeRecoveryActionKind) {
    if (kind === "resolve-writer-conflict" && !confirmingWriterTakeover) {
      setConfirmingWriterTakeover(true);
      return;
    }
    const adapter = adapterRef.current;
    if (!adapter || recoveringAction) return;
    setError(undefined);
    setRecoveringAction(kind);
    try {
      const next = await adapter.recovery.run(kind);
      setRuntime(next);
      setConfirmingWriterTakeover(false);
      if (kind === "clear-cache") {
        setEditorStatus("Package cache cleared · Local Draft preserved");
      } else if (kind === "resolve-writer-conflict") {
        setEditorStatus("Writer lease acquired · Local Draft preserved");
      }
      if (
        next.previewUrl
        && previewConfiguration.status === "enabled"
        && (kind === "retry" || kind === "reset-runtime" || kind === "restart-dev-server")
      ) {
        await swapPreviewBridge(adapter, next.previewUrl);
      }
    } catch {
      if (!unmountedRef.current && adapterRef.current === adapter) {
        setError("Recovery did not complete. Your Local Draft remains available; review the action and retry.");
      }
    } finally {
      if (!unmountedRef.current) setRecoveringAction(undefined);
    }
  }

  async function createPreviewBridge(internalPreviewUrl: string): Promise<SubdomainPreviewBridge> {
    if (previewConfiguration.status === "disabled") throw new Error("Preview unavailable");
    let created: SubdomainPreviewBridge | undefined;
    created = await (previewBridgeFactory ?? createSubdomainPreviewBridge)({
      configuration: previewConfiguration,
      internalProjectIdentity: `${workspaceScope}:${project.id}`,
      internalPreviewUrl,
      ownerId: project.ownerId,
      ownerType: project.ownerType,
      projectId: project.id,
      onDiagnostic() {
        if (!unmountedRef.current) setError("The isolated Preview relay was stopped safely.");
      },
      onRecoveryRequired() {
        if (created) recoverPreview(created, internalPreviewUrl);
      }
    });
    return created;
  }

  async function swapPreviewBridge(
    adapter: RuntimeAdapter,
    internalPreviewUrl: string,
    expectedBridge?: SubdomainPreviewBridge
  ): Promise<boolean> {
    if (expectedBridge && previewBridgeRef.current !== expectedBridge) return false;

    const operation = previewBridgeOperationRef.current + 1;
    previewBridgeOperationRef.current = operation;
    const previousBridge = previewBridgeRef.current;
    previewBridgeRef.current = undefined;
    if (!unmountedRef.current) setIsolatedPreviewUrl(undefined);
    await previousBridge?.dispose();

    if (
      unmountedRef.current
      || adapterRef.current !== adapter
      || previewBridgeOperationRef.current !== operation
    ) return false;

    const createdBridge = await createPreviewBridge(internalPreviewUrl);
    if (
      unmountedRef.current
      || adapterRef.current !== adapter
      || previewBridgeOperationRef.current !== operation
    ) {
      await createdBridge.dispose();
      return false;
    }

    previewBridgeRef.current = createdBridge;
    setIsolatedPreviewUrl(createdBridge.url);
    return true;
  }

  function recoverPreview(staleBridge: SubdomainPreviewBridge, internalPreviewUrl: string): void {
    if (previewRecoveryRef.current || previewBridgeRef.current !== staleBridge || unmountedRef.current) return;
    const adapter = adapterRef.current;
    if (!adapter) return;
    const recovery = (async () => {
      try {
        await swapPreviewBridge(adapter, internalPreviewUrl, staleBridge);
      } catch {
        if (!unmountedRef.current && adapterRef.current === adapter) {
          setError("The isolated Preview could not recover. Run Preview again.");
        }
      }
    })().finally(() => { previewRecoveryRef.current = null; });
    previewRecoveryRef.current = recovery;
  }

  function saveSelectedFile() {
    const adapter = adapterRef.current;
    if (!adapter || !selectedPath) return;
    setError(undefined);
    setIsSaving(true);
    try {
      const next = adapter.workspace.writeText(selectedPath, editorContent);
      setRuntime(next);
      setWorkspace(adapter.workspace.getState());
      previewBridgeRef.current?.hotUpdate(selectedPath);
      setEditorStatus(next.hmrState === "connected" ? "Local Draft saved · HMR applied" : "Local Draft saved · restart may be required");
    } catch {
      setError("The text edit could not be saved safely.");
    } finally {
      setIsSaving(false);
    }
  }

  async function saveToServer() {
    const adapter = adapterRef.current;
    if (!adapter || !projectEtag || isServerSaving || replacementAbortRef.current !== null || runtime.localDraftAccess !== "writer") return;
    const controller = new AbortController();
    saveAbortRef.current?.abort();
    saveAbortRef.current = controller;
    setError(undefined);
    setServerSaveFailure(undefined);
    setIsServerSaving(true);
    setServerSaveStatus("Planning canonical Server Save…");
    try {
      if (selectedPath && editorStatus === "Unsaved Local Draft") {
        const next = adapter.workspace.writeText(selectedPath, editorContent);
        setRuntime(next);
        setWorkspace(adapter.workspace.getState());
        previewBridgeRef.current?.hotUpdate(selectedPath);
        setEditorStatus("Local Draft saved for Server Save");
      }
      const { saveCurrentProject } = await saveFeature.load();
      const result = await saveCurrentProject({
        client: createBrowserApiClient(),
        csrfToken: readCsrfCredential(),
        owner: { ownerType: project.ownerType, ownerId: project.ownerId },
        projectId: project.id,
        storageScopeId: project.storageScopeId,
        projectEtag,
        snapshotCurrentTree: () => adapter.workspace.snapshotBundleFiles(),
        currentRevision: () => adapter.workspace.currentRevision(),
        signal: controller.signal,
        onProgress(progress) {
          if (controller.signal.aborted) return;
          const percentage = progress.totalBytes && progress.uploadedBytes > 0
            ? ` ${Math.floor(progress.uploadedBytes * 100 / progress.totalBytes)}%`
            : "";
          setServerSaveStatus(`${progress.phase}${percentage} · Local Draft preserved`);
        }
      });
      onProjectCommit?.({ projectEtag: result.projectEtag, projectVersion: result.projectVersion });
      setServerSaveStatus(result.snapshotCurrent
        ? `Server Save v${result.projectVersion} complete · Local Draft is current`
        : `Server Save v${result.projectVersion} complete · newer Local Draft changes remain`);
    } catch (cause) {
      if (!controller.signal.aborted) {
        const stale = cause instanceof Error && "status" in cause && (cause as { status?: unknown }).status === 412;
        setServerSaveFailure(stale ? "stale" : "retry");
        setError(stale
          ? "The Server Project changed before this Save. Your Local Draft is preserved; reload the latest Project before retrying."
          : "Server Save did not complete. Your Local Draft is preserved; retry when the service is available.");
        setServerSaveStatus("Server Save failed · Local Draft preserved");
      }
    } finally {
      if (saveAbortRef.current === controller) saveAbortRef.current = null;
      if (!unmountedRef.current) setIsServerSaving(false);
    }
  }

  async function stopWorkspace() {
    saveAbortRef.current?.abort();
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
    setEditorStatus("Local Draft");
    setResumeStatus(undefined);
  }

  async function replaceLocalDraftWithRestoredSave(head: RestoredProjectHead): Promise<void> {
    if (
      project.state !== "active" || isStarting || isServerSaving || replacementAbortRef.current !== null
    ) return;
    if (projectEtagRef.current !== head.projectEtag) {
      setError("The Server Project changed after this restore. Your Local Draft is preserved; reload history before replacing it.");
      return;
    }

    const controller = new AbortController();
    replacementAbortRef.current = controller;
    setIsReplacingDraft(true);
    setError(undefined);
    setResumeStatus(`Preparing exact restored Server Save v${head.projectVersion} without changing the Local Draft…`);
    let stagedAdapter: RuntimeAdapter | undefined;
    try {
      const [feature, revision, savedContent] = await Promise.all([
        runtimeFeatureLoader?.() ?? runtimeFeature.load(),
        resolveRuntimeAssetRevision(assetRevision, controller.signal),
        (resumeProjectContentLoader?.() ?? resumeFeature.load()).then(({ resumeProjectContent }) => resumeProjectContent({
          ownerType: project.ownerType,
          ownerId: project.ownerId,
          projectId: project.id,
          storageScopeId: project.storageScopeId
        }, { signal: controller.signal }))
      ]);
      if (
        controller.signal.aborted ||
        savedContent.descriptor.projectVersion !== head.projectVersion ||
        projectEtagRef.current !== head.projectEtag
      ) {
        throw new RestoredHeadChangedError();
      }

      stagedAdapter = feature.createRuntimeAdapter();
      const origin = globalThis.location.origin;
      const base = `/runtime/${revision}`;
      await stagedAdapter.mount({
        project: {
          id: project.id,
          storageScopeId: project.storageScopeId,
          workspaceScopeId: workspaceScope,
          displayName: project.name
        },
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
        reportDiagnostic() { /* staged diagnostics are surfaced only if promotion fails */ }
      });
      const stagedWorkspace = await stagedAdapter.workspace.materializeBundle(savedContent.files);
      if (
        controller.signal.aborted ||
        stagedWorkspace.status !== "ready" ||
        savedContent.descriptor.projectVersion !== head.projectVersion ||
        projectEtagRef.current !== head.projectEtag
      ) {
        throw new RestoredHeadChangedError();
      }

      const previousAdapter = adapterRef.current;
      const previousUnsubscribe = unsubscribeRef.current;
      const previousBridge = previewBridgeRef.current;
      previewBridgeOperationRef.current += 1;
      previewBridgeRef.current = undefined;
      setIsolatedPreviewUrl(undefined);
      previousUnsubscribe();

      adapterRef.current = stagedAdapter;
      stagedAdapter = undefined;
      unsubscribeRef.current = adapterRef.current.subscribe(setRuntime);
      setRuntime(adapterRef.current.getState());
      setWorkspace(stagedWorkspace);
      setTerminalOutput("");
      const firstTextFile = stagedWorkspace.files.find((file) => file.kind === "text");
      if (firstTextFile) selectFile(firstTextFile.path, stagedWorkspace);
      else {
        setSelectedPath(undefined);
        setEditorContent("");
      }
      setEditorStatus(`Restored Server Save v${head.projectVersion} · Local Draft replaced by explicit choice`);
      setResumeStatus(`Verified restored Server Save v${head.projectVersion} is now the Local Draft.`);

      const cleanup = await Promise.allSettled([
        previousBridge?.dispose() ?? Promise.resolve(),
        previousAdapter?.dispose() ?? Promise.resolve()
      ]);
      if (cleanup.some((result) => result.status === "rejected")) {
        setError("The restored Local Draft is ready, but the previous Runtime did not release cleanly. Reload before starting Preview.");
      }
      if (adapterRef.current.getState().localDraftAccess !== "writer") {
        try {
          setRuntime(await adapterRef.current.recovery.run("resolve-writer-conflict"));
        } catch {
          setError("The restored Local Draft is ready in read-only mode because its writer lease could not be acquired. Reload before editing.");
        }
      }
    } catch (cause) {
      await stagedAdapter?.dispose();
      if (!controller.signal.aborted) {
        setError(cause instanceof RestoredHeadChangedError
          ? "The Server Project changed before the restored Save could be promoted. Your previous Local Draft is preserved."
          : "The restored Server Save could not be fetched, verified, and materialized safely. Your previous Local Draft is preserved.");
        setResumeStatus("Restored Save replacement stopped · previous Local Draft preserved");
      }
    } finally {
      if (replacementAbortRef.current === controller) replacementAbortRef.current = null;
      if (!unmountedRef.current) setIsReplacingDraft(false);
    }
  }

  async function releaseAdapter() {
    previewBridgeOperationRef.current += 1;
    const bridge = previewBridgeRef.current;
    previewBridgeRef.current = undefined;
    if (!unmountedRef.current) setIsolatedPreviewUrl(undefined);
    await bridge?.dispose();
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
  const hasIsolatedPreview = isolatedPreviewUrl !== undefined;
  const canWriteLocalDraft = runtime.localDraftAccess === "writer";
  const recoveryDiagnostics = runtime.diagnostics.filter((diagnostic) => diagnostic.actions.length > 0);

  return (
    <section className="mt-6 overflow-hidden rounded-lg border border-border bg-surface" aria-labelledby="project-ide-title">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-muted-border bg-subtle px-4 py-3">
        <div><p className="m-0 text-xs text-muted-foreground">Browser workspace · {runtime.lifecycle}</p><h3 id="project-ide-title" className="m-0 text-sm font-semibold">{project.name} IDE</h3></div>
        {hasWorkspace ? <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground" role="status" aria-live="polite">{isReplacingDraft ? "Preparing restored Save · current Local Draft preserved" : serverSaveStatus}</span><Button type="button" size="sm" variant="primary" disabled={isServerSaving || isReplacingDraft || !projectEtag || !canWriteLocalDraft} onClick={() => void saveToServer()}>{isServerSaving ? "Saving…" : "Save to server"}</Button><Button type="button" size="sm" disabled={isReplacingDraft} onClick={() => void stopWorkspace()}>Stop workspace</Button></div> : (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="primary" disabled={isStarting || project.state !== "active"} onClick={() => void startWorkspace("saved")}>{startingSource === "saved" ? "Resuming…" : "Resume saved Project"}</Button>
            <Button type="button" size="sm" disabled={isStarting || project.state !== "active"} onClick={() => void startWorkspace("template")}>{startingSource === "template" ? "Starting…" : "Start workspace from template"}</Button>
          </div>
        )}
      </header>
      {error ? <p className="m-3 rounded-md border border-danger p-3 text-sm text-danger" role="alert">{error}</p> : null}
      {serverSaveFailure ? <div className="mx-3 mt-3 flex flex-wrap gap-2" aria-label="Server Save recovery">{serverSaveFailure === "retry" ? <Button type="button" size="sm" disabled={isServerSaving || !canWriteLocalDraft} onClick={() => void saveToServer()}>Retry Server Save</Button> : <Button type="button" size="sm" onClick={() => onProjectReload?.()}>Reload latest Project</Button>}</div> : null}
      {resumeStatus ? <p className="m-3 text-sm text-muted-foreground" role="status" aria-live="polite">{resumeStatus}</p> : null}
      {recoveryDiagnostics.length > 0 ? (
        <section className="m-3 rounded-md border border-warning bg-subtle p-3" aria-label="Workspace recovery">
          <h4 className="m-0 text-sm font-semibold">Workspace needs attention</h4>
          {recoveryDiagnostics.map((diagnostic) => (
            <div className="mt-2" key={diagnostic.code}>
              <p className="m-0 text-sm"><span className="font-mono text-xs">{diagnostic.code}</span> · {diagnostic.message}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {diagnostic.actions.map((action) => (
                  <Button
                    type="button"
                    size="sm"
                    key={`${diagnostic.code}:${action.kind}`}
                    disabled={recoveringAction !== undefined}
                    onClick={() => void executeRecovery(action.kind)}
                  >
                    {recoveringAction === action.kind ? "Recovering…" : action.label}
                  </Button>
                ))}
              </div>
            </div>
          ))}
          {confirmingWriterTakeover ? (
            <div className="mt-3 rounded-md border border-danger p-3" role="alertdialog" aria-labelledby="writer-takeover-title">
              <p id="writer-takeover-title" className="m-0 text-sm font-semibold">Take over editing from the other tab?</p>
              <p className="mb-3 mt-1 text-xs text-muted-foreground">The other tab becomes read-only. Its unsaved editor text stays visible, but only this tab may write the Local Draft.</p>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="primary" onClick={() => void executeRecovery("resolve-writer-conflict")}>Confirm writer takeover</Button>
                <Button type="button" size="sm" onClick={() => setConfirmingWriterTakeover(false)}>Cancel</Button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
      <div className="px-3">
        <ProjectHistoryPanel
          hasLocalDraft={hasWorkspace}
          project={project}
          {...(projectEtag === undefined ? {} : { projectEtag })}
          onProjectCommit={(result) => onProjectCommit?.(result)}
          onReloadProject={() => onProjectReload?.()}
          onResumeRestoredSave={(head) => void replaceLocalDraftWithRestoredSave(head)}
        />
      </div>
      {project.state !== "active" ? <p className="m-3 text-sm text-muted-foreground">This archived Project is read-only. Its Versions and Recovery checkpoints remain available for inspection; restore the Project before mutating history or starting its workspace.</p> : null}
      {hasWorkspace ? (
        <div className="grid min-h-[34rem] grid-cols-1 lg:grid-cols-[14rem_minmax(0,1fr)_minmax(18rem,0.8fr)]">
          <nav className="border-b border-muted-border bg-sidebar p-3 lg:border-r lg:border-b-0" aria-label="Project files">
            <p className="mb-2 mt-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Files</p>
            <ul className="m-0 grid list-none gap-1 p-0">{workspace.files.map((file) => <li key={file.path}><button type="button" className="w-full rounded-sm px-2 py-1.5 text-left font-mono text-xs hover:bg-hover aria-[current=page]:bg-selected" aria-current={selectedPath === file.path ? "page" : undefined} onClick={() => selectFile(file.path)}>{file.path}</button></li>)}</ul>
          </nav>
          <section className="grid min-w-0 grid-rows-[auto_minmax(16rem,1fr)_auto] border-b border-muted-border lg:border-r lg:border-b-0" aria-label="Text editor">
            <div className="border-b border-muted-border bg-subtle px-3 py-2 font-mono text-xs text-muted-foreground">{selectedPath ?? "Select a file"}</div>
            {selectedPath ? <textarea className="h-full min-h-64 w-full resize-none border-0 bg-surface p-4 font-mono text-sm leading-6 text-foreground outline-none read-only:cursor-not-allowed read-only:bg-subtle" aria-label={`Editor for ${selectedPath}`} spellCheck={false} readOnly={!canWriteLocalDraft} value={editorContent} onChange={(event) => { setEditorContent(event.currentTarget.value); setEditorStatus("Unsaved Local Draft"); }} /> : <p className="p-4 text-sm text-muted-foreground">Choose a text file from the tree.</p>}
            <div className="relative z-10 flex items-center justify-between gap-3 border-t border-muted-border bg-surface px-3 py-2 text-xs text-muted-foreground"><span>{editorStatus} · {canWriteLocalDraft ? "writer" : "read-only"} · {workspace.files.length} files · {workspace.totalBytes} bytes</span><Button type="button" size="sm" disabled={!selectedPath || isSaving || !canWriteLocalDraft} onClick={saveSelectedFile}>{isSaving ? "Applying…" : "Apply to Local Draft"}</Button></div>
          </section>
          <div className="grid min-w-0 grid-rows-[minmax(12rem,1fr)_minmax(12rem,1fr)] overflow-hidden">
            <section className="grid min-h-0 grid-rows-[auto_1fr] border-b border-muted-border" aria-label="Preview" data-preview-url={isolatedPreviewUrl}><div className="flex items-center justify-between gap-3 border-b border-muted-border p-3"><div><h4 className="m-0 text-sm font-semibold">Preview</h4><p className="m-0 text-xs text-muted-foreground">{runtime.workflowPhase} · HMR {runtime.hmrState}</p></div>{hasIsolatedPreview ? null : <Button type="button" size="sm" variant="primary" disabled={isRunningPreview || previewConfiguration.status === "disabled"} onClick={() => void runPreview()}>{isRunningPreview ? "Installing…" : "Run Preview"}</Button>}</div>{hasIsolatedPreview ? <iframe ref={(frame) => previewBridgeRef.current?.attach(frame?.contentWindow ?? null)} title={`${project.name} Preview`} className="h-full min-h-0 w-full border-0 bg-white" src={isolatedPreviewUrl} sandbox="allow-scripts allow-same-origin" allow="cross-origin-isolated" referrerPolicy="no-referrer" /> : previewConfiguration.status === "disabled" ? <p className="p-3 text-sm text-muted-foreground" role="status">{previewConfiguration.message} Same-origin Preview is disabled.</p> : runtime.previewUrl ? <p className="p-3 text-sm text-muted-foreground" role="status">The isolated Preview connection is not ready. Same-origin Preview is disabled.</p> : <p className="p-3 text-sm text-muted-foreground">Run bounded install and dev to open the isolated Preview.</p>}</section>
            <section className="grid min-h-0 grid-rows-[auto_minmax(8rem,1fr)_auto] bg-background" aria-label="Terminal">
              <h4 className="m-0 border-b border-muted-border px-3 py-2 text-sm font-semibold">Terminal</h4>
              <pre className="m-0 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs" aria-live="polite">{terminalOutput || "Run a bounded browser command."}</pre>
              <form className="flex gap-2 border-t border-muted-border p-2" onSubmit={runCommand}><label className="sr-only" htmlFor={`terminal-command-${project.id}`}>Terminal command</label><input id={`terminal-command-${project.id}`} name="command" className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 font-mono text-sm" autoComplete="off" maxLength={MAX_TERMINAL_COMMAND_CHARS} /><Button type="submit" size="sm">Run</Button></form>
            </section>
          </div>
        </div>
      ) : <div className="p-6"><p className="m-0 text-sm text-muted-foreground">Resume the verified current Server Save, or start from the template only when this Project has not been saved yet. A failed integrity check never replaces the Local Draft.</p></div>}
    </section>
  );
}

function runtimeErrorCode(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("code" in value)) return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && /^RUNTIME_[A-Z0-9_]{1,56}$/u.test(code) ? code : null;
}

function projectContentErrorCode(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("code" in value)) return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && /^RESUME_[A-Z_]{1,48}$/u.test(code) ? code : null;
}

function resumeErrorMessage(code: string): string {
  if (code === "RESUME_AUTHENTICATION_REQUIRED") {
    return "Your session expired. Sign in again, then resume this Project. No Local Draft was replaced.";
  }
  if (code === "RESUME_NOT_SAVED") {
    return "This Project has no current Server Save. Start from the template to create its first Local Draft.";
  }
  if (code === "RESUME_CONTENT_UNAVAILABLE") {
    return "The current Server Save is no longer available to this account. No Local Draft was replaced.";
  }
  if (code === "RESUME_LIMIT_EXCEEDED") {
    return "The current Server Save exceeds the browser workspace limit. No files were materialized.";
  }
  if (code === "RESUME_INTEGRITY_FAILED") {
    return "The current Server Save failed integrity verification. No files were materialized; retry or ask an administrator to inspect storage.";
  }
  if (code === "RESUME_ABORTED") return "Project resume was cancelled. No Local Draft was replaced.";
  return "The current Server Save could not be resumed. No Local Draft was replaced; retry when the service is available.";
}

class RestoredHeadChangedError extends Error {}
