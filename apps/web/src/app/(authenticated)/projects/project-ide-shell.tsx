"use client";

import type { Project } from "@nuriteo/api-client";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { Button } from "../../../components/ui/button.tsx";
import { ConfirmationDialog } from "../../../components/ui/confirmation-dialog.tsx";
import { createBrowserApiClient } from "../../../lib/api/browser-client.ts";
import { readCsrfCredential } from "../../../lib/api/browser-security.ts";
import { createRetryableLazyFeature } from "../../../lib/retryable-lazy-feature.ts";
import { useUnsavedChangesGuard } from "../../../lib/use-unsaved-changes-guard.ts";
import type {
  RuntimeAdapter,
  RuntimeRecoveryActionKind,
  RuntimeViewState,
  RuntimeWorkspaceFile,
  RuntimeWorkspaceState
} from "../../../runtime/runtime-adapter.ts";
import { resolveRuntimeAssetRevision } from "../../../runtime/runtime-assets.ts";
import { awaitWorkspaceStart } from "../../../runtime/workspace-start.ts";
import { createSubdomainPreviewBridge } from "../../../runtime/subdomain-preview-bridge.ts";
import type { PreviewOriginConfiguration } from "../../../runtime/preview-origin-contract.ts";
import type { SubdomainPreviewBridge } from "../../../runtime/subdomain-preview-bridge.ts";
import { ProjectHistoryPanel } from "./project-history-panel.tsx";
import type { RestoredProjectHead } from "./project-history-panel.tsx";
import { useProjectFileSearch } from "./use-project-file-search.ts";

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
const FILE_LIST_BATCH_SIZE = 200;
const EMPTY_WORKSPACE_FILES: readonly RuntimeWorkspaceFile[] = [];

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
type UtilityPanel = "preview" | "terminal";

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
  const fileSearchRef = useRef<HTMLInputElement | null>(null);
  const projectEtagRef = useRef(projectEtag);
  const terminalTruncatedRef = useRef(false);
  const unmountedRef = useRef(false);
  const [workspace, setWorkspace] = useState<RuntimeWorkspaceState>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [editorContent, setEditorContent] = useState("");
  const [terminalOutput, setTerminalOutput] = useState("");
  const [terminalWasTruncated, setTerminalWasTruncated] = useState(false);
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
  const [fileQuery, setFileQuery] = useState("");
  const [fileListLimit, setFileListLimit] = useState(FILE_LIST_BATCH_SIZE);
  const [utilityPanel, setUtilityPanel] = useState<UtilityPanel>("preview");
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [hasUnpublishedChanges, setHasUnpublishedChanges] = useState(false);
  const [confirmingWorkspaceStop, setConfirmingWorkspaceStop] = useState(false);
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        fileSearchRef.current?.focus();
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
      setHasUnpublishedChanges(savedContent === undefined);
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
    setUtilityPanel("preview");
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
      setHasUnpublishedChanges(!result.snapshotCurrent);
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
    terminalTruncatedRef.current = false;
    setTerminalWasTruncated(false);
    setEditorStatus("Local Draft");
    setResumeStatus(undefined);
    setFileQuery("");
    setFileListLimit(FILE_LIST_BATCH_SIZE);
    setIsFocusMode(false);
    setHasUnpublishedChanges(false);
    setConfirmingWorkspaceStop(false);
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
      setHasUnpublishedChanges(false);
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
    setTerminalOutput((current) => {
      const next = `${current}${value}`;
      if (next.length > MAX_TERMINAL_OUTPUT_CHARS && !terminalTruncatedRef.current) {
        terminalTruncatedRef.current = true;
        setTerminalWasTruncated(true);
      }
      return next.slice(-MAX_TERMINAL_OUTPUT_CHARS);
    });
  }

  const hasWorkspace = workspace?.status === "ready";
  const hasIsolatedPreview = isolatedPreviewUrl !== undefined;
  const canWriteLocalDraft = runtime.localDraftAccess === "writer";
  const recoveryDiagnostics = runtime.diagnostics.filter((diagnostic) => diagnostic.actions.length > 0);
  const {
    hasMoreFiles,
    isSearchPending: isFileSearchPending,
    matchingFiles,
    visibleFiles
  } = useProjectFileSearch({
    files: workspace?.files ?? EMPTY_WORKSPACE_FILES,
    limit: fileListLimit,
    query: fileQuery,
    selectedPath
  });
  const hasUnsavedEditorChange = editorStatus === "Unsaved Local Draft";
  const selectedFileName = selectedPath?.split("/").at(-1);
  const editorLineCount = editorContent.length === 0 ? 1 : editorContent.split("\n").length;
  useUnsavedChangesGuard(hasUnpublishedChanges || hasUnsavedEditorChange);

  return (
    <section className={`project-ide-shell${isFocusMode ? " project-ide-shell--focus" : ""}`} aria-labelledby="project-ide-title">
      <header className="project-ide-header">
        <div className="project-ide-header__identity">
          <span className={`project-ide-runtime-dot project-ide-runtime-dot--${runtime.lifecycle}`} aria-hidden="true" />
          <div><p>브라우저 워크스페이스 · {runtime.lifecycle}</p><h3 id="project-ide-title" aria-label={`${project.name} IDE`}>{project.name}</h3></div>
          {hasWorkspace ? <span className={`project-ide-access project-ide-access--${canWriteLocalDraft ? "writer" : "reader"}`}>{canWriteLocalDraft ? "편집 가능" : "읽기 전용"}</span> : null}
        </div>
        {hasWorkspace ? <div className="project-ide-header__actions">
          <span className="project-ide-save-state" role="status" aria-live="polite"><i className={hasUnsavedEditorChange ? "is-dirty" : ""} aria-hidden="true" />{isReplacingDraft ? "복원본 준비 중 · 현재 초안 보존됨" : serverSaveStatus}</span>
          <Button type="button" size="sm" aria-pressed={isFocusMode} onClick={() => setIsFocusMode((current) => !current)}>{isFocusMode ? "패널 표시" : "집중 모드"}</Button>
          <Button aria-label="Save to server" type="button" size="sm" variant="primary" disabled={isServerSaving || isReplacingDraft || !projectEtag || !canWriteLocalDraft} onClick={() => void saveToServer()}>{isServerSaving ? "저장 중…" : "서버에 저장"}<kbd>⌘S</kbd></Button>
          <Button aria-label="Stop workspace" type="button" size="sm" disabled={isReplacingDraft} onClick={() => {
            if (hasUnpublishedChanges || hasUnsavedEditorChange) setConfirmingWorkspaceStop(true);
            else void stopWorkspace();
          }}>종료</Button>
        </div> : null}
      </header>
      {error ? <div className="project-ide-message project-ide-message--error" role="alert"><strong>작업을 완료하지 못했습니다.</strong><span>{error}</span></div> : null}
      {serverSaveFailure ? <div className="project-ide-recovery-actions" aria-label="Server Save recovery">{serverSaveFailure === "retry" ? <Button type="button" size="sm" disabled={isServerSaving || !canWriteLocalDraft} onClick={() => void saveToServer()}>Retry Server Save</Button> : <Button type="button" size="sm" onClick={() => onProjectReload?.()}>Reload latest Project</Button>}</div> : null}
      {resumeStatus ? <p className="project-ide-message project-ide-message--status" role="status" aria-live="polite">{resumeStatus}</p> : null}
      {recoveryDiagnostics.length > 0 ? (
        <section className="project-ide-recovery" aria-label="Workspace recovery">
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
      {project.state !== "active" ? <p className="m-3 text-sm text-muted-foreground">This archived Project is read-only. Its Versions and Recovery checkpoints remain available for inspection; restore the Project before mutating history or starting its workspace.</p> : null}
      {hasWorkspace ? (
        <div className="project-ide-workbench">
          <nav className="project-ide-files" aria-label="Project files">
            <div className="project-ide-panel-heading"><div><span>EXPLORER</span><strong>파일</strong></div><kbd>⌘P</kbd></div>
            <label className="project-ide-file-search"><span className="sr-only">파일 검색</span><input ref={fileSearchRef} value={fileQuery} onChange={(event) => { setFileQuery(event.currentTarget.value); setFileListLimit(FILE_LIST_BATCH_SIZE); }} placeholder="파일 검색" autoComplete="off" /><span aria-hidden="true">{isFileSearchPending ? "…" : "⌕"}</span></label>
            <p className="project-ide-file-count" aria-live="polite">{visibleFiles.length}개 표시 · {matchingFiles.length}개 일치 · 전체 {workspace.files.length}개</p>
            {visibleFiles.length > 0 ? <ul>{visibleFiles.map((file) => <li key={file.path}><button type="button" aria-current={selectedPath === file.path ? "page" : undefined} onClick={() => selectFile(file.path)}><span className="project-ide-file-icon" aria-hidden="true">{file.kind === "text" ? "#" : "◆"}</span><span>{file.path}</span>{selectedPath === file.path && hasUnsavedEditorChange ? <i aria-label="저장하지 않은 변경 사항" /> : null}</button></li>)}</ul> : <p className="project-ide-files__empty">일치하는 파일이 없습니다.</p>}
            {hasMoreFiles ? <button className="project-ide-files__more" type="button" onClick={() => setFileListLimit((current) => current + FILE_LIST_BATCH_SIZE)}>다음 {Math.min(FILE_LIST_BATCH_SIZE, matchingFiles.length - visibleFiles.length)}개 보기</button> : null}
          </nav>
          <section className="project-ide-editor" aria-label="Text editor">
            <div className="project-ide-editor__tabs">{selectedPath ? <div className="is-active"><span className="project-ide-file-icon" aria-hidden="true">#</span><strong>{selectedFileName}</strong>{hasUnsavedEditorChange ? <i aria-label="저장하지 않은 변경 사항" /> : <button type="button" aria-label={`${selectedFileName} 닫기`} onClick={() => { setSelectedPath(undefined); setEditorContent(""); }}>×</button>}</div> : <span>파일을 선택하세요</span>}</div>
            <div className="project-ide-editor__breadcrumb"><span>{project.name}</span>{selectedPath?.split("/").map((segment) => <span key={segment}>{segment}</span>)}</div>
            {selectedPath ? <textarea className="project-ide-editor__input" aria-label={`Editor for ${selectedPath}`} spellCheck={false} readOnly={!canWriteLocalDraft} value={editorContent} onChange={(event) => { setEditorContent(event.currentTarget.value); setEditorStatus("Unsaved Local Draft"); setHasUnpublishedChanges(true); }} /> : <div className="project-ide-editor__empty"><span aria-hidden="true">⌘</span><strong>편집할 파일을 선택하세요</strong><p>왼쪽 파일 목록에서 선택하거나 <kbd>⌘P</kbd>로 빠르게 찾을 수 있습니다.</p></div>}
            <div className="project-ide-editor__status"><span><i className={hasUnsavedEditorChange ? "is-dirty" : ""} aria-hidden="true" />{editorStatus}</span><span>Ln {editorLineCount} · {editorContent.length}자 · UTF-8</span><Button aria-label="Apply to Local Draft" type="button" size="sm" disabled={!selectedPath || isSaving || !canWriteLocalDraft} onClick={saveSelectedFile}>{isSaving ? "적용 중…" : "로컬 초안에 적용"}</Button></div>
          </section>
          <aside className="project-ide-utility">
            <div className="project-ide-utility__tabs" role="tablist" aria-label="실행 도구"><button type="button" role="tab" aria-selected={utilityPanel === "preview"} onClick={() => setUtilityPanel("preview")}>미리보기{runtime.hmrState === "connected" ? <i aria-hidden="true" /> : null}</button><button type="button" role="tab" aria-selected={utilityPanel === "terminal"} onClick={() => setUtilityPanel("terminal")}>터미널{runtime.terminalProcessCount > 0 ? <span>{runtime.terminalProcessCount}</span> : null}</button></div>
            <section className="project-ide-preview" aria-label="Preview" data-preview-url={isolatedPreviewUrl} hidden={utilityPanel !== "preview"}><div className="project-ide-preview__toolbar"><div><strong>LIVE PREVIEW</strong><span>{runtime.workflowPhase} · HMR {runtime.hmrState}</span></div>{hasIsolatedPreview ? <span className="project-ide-live"><i aria-hidden="true" /> LIVE</span> : <Button aria-label="Run Preview" type="button" size="sm" variant="primary" disabled={isRunningPreview} onClick={() => void runPreview()}>{isRunningPreview ? "설치 중…" : "미리보기 실행"}</Button>}</div>{hasIsolatedPreview ? <iframe ref={(frame) => previewBridgeRef.current?.attach(frame?.contentWindow ?? null)} title={`${project.name} Preview`} src={isolatedPreviewUrl} sandbox="allow-scripts allow-same-origin" allow="cross-origin-isolated" referrerPolicy="no-referrer" /> : previewConfiguration.status === "disabled" ? <div className="project-ide-utility__empty" role="status"><strong>미리보기를 사용할 수 없습니다.</strong><p>{previewConfiguration.message} Same-origin Preview is disabled.</p></div> : runtime.previewUrl ? <div className="project-ide-utility__empty" role="status"><strong>격리된 연결을 준비하고 있습니다.</strong><p>The isolated Preview connection is not ready. Same-origin Preview is disabled.</p></div> : <div className="project-ide-utility__empty"><span aria-hidden="true">▷</span><strong>실행 결과를 바로 확인하세요</strong><p>의존성을 설치하고 개발 서버를 시작합니다.</p></div>}</section>
            <section className="project-ide-terminal" aria-label="Terminal" hidden={utilityPanel !== "terminal"}><div className="project-ide-terminal__toolbar"><strong>TERMINAL</strong><span>{terminalWasTruncated ? "최근 64KB만 표시" : runtime.terminalProcessCount > 0 ? `${runtime.terminalProcessCount}개 프로세스 실행 중` : "대기 중"}</span></div><pre aria-live="polite">{terminalOutput || "브라우저 안에서 제한된 명령을 실행할 수 있습니다."}</pre><form onSubmit={runCommand}><label className="sr-only" htmlFor={`terminal-command-${project.id}`}>Terminal command</label><span aria-hidden="true">›</span><input id={`terminal-command-${project.id}`} name="command" placeholder="명령어 입력" autoComplete="off" maxLength={MAX_TERMINAL_COMMAND_CHARS} /><Button type="submit" size="sm">실행</Button></form></section>
          </aside>
        </div>
      ) : <div className="project-ide-start"><div className="project-ide-start__copy"><span className="project-ide-start__mark" aria-hidden="true">N</span><p className="eyebrow">BROWSER IDE</p><h4>코드를 열고,<br />바로 실행하세요.</h4><p>서버에 저장된 작업을 안전하게 이어가거나, 새로운 React 템플릿으로 바로 시작하세요.</p></div><div className="project-ide-start__actions"><button aria-label="Resume saved Project" type="button" disabled={isStarting || project.state !== "active"} onClick={() => void startWorkspace("saved")}><span aria-hidden="true">↗</span><strong>{startingSource === "saved" ? "불러오는 중…" : "저장된 프로젝트 이어서 열기"}</strong><small>무결성을 확인한 최신 서버 저장본을 엽니다.</small></button><button aria-label="Start workspace from template" type="button" disabled={isStarting || project.state !== "active"} onClick={() => void startWorkspace("template")}><span aria-hidden="true">＋</span><strong>{startingSource === "template" ? "시작하는 중…" : "새 템플릿으로 시작"}</strong><small>Vite + React 기본 구성으로 로컬 초안을 만듭니다.</small></button></div><p className="project-ide-start__safety">브라우저의 로컬 초안은 명시적으로 서버에 저장하기 전까지 기존 서버 버전을 덮어쓰지 않습니다.</p></div>}
      <details className="project-ide-history" open>
        <summary><span>버전과 복구</span><small>서버 저장 이력과 체크포인트</small></summary>
        <ProjectHistoryPanel
          hasLocalDraft={hasWorkspace}
          project={project}
          {...(projectEtag === undefined ? {} : { projectEtag })}
          onProjectCommit={(result) => onProjectCommit?.(result)}
          onReloadProject={() => onProjectReload?.()}
          onResumeRestoredSave={(head) => void replaceLocalDraftWithRestoredSave(head)}
        />
      </details>
      <ConfirmationDialog
        confirmLabel="초안을 버리고 종료"
        description="서버에 저장하지 않은 로컬 초안과 편집 중인 내용이 사라집니다. 필요한 변경은 먼저 서버에 저장하세요."
        open={confirmingWorkspaceStop}
        title="브라우저 워크스페이스를 종료할까요?"
        onCancel={() => setConfirmingWorkspaceStop(false)}
        onConfirm={() => void stopWorkspace()}
      />
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
