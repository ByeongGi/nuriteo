"use client";

import type { Project } from "@nuriteo/api-client";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { Button } from "#src/components/ui/button.tsx";
import { ConfirmationDialog } from "#src/components/ui/confirmation-dialog.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { createRetryableLazyFeature } from "#src/lib/retryable-lazy-feature.ts";
import { useUnsavedChangesGuard } from "#src/lib/use-unsaved-changes-guard.ts";
import type {
  RuntimeAdapter,
  RuntimeRecoveryActionKind,
  RuntimeViewState,
  RuntimeWorkspaceFile,
  RuntimeWorkspaceState
} from "#src/runtime/runtime-adapter.ts";
import { resolveRuntimeAssetRevision } from "#src/runtime/runtime-assets.ts";
import { awaitWorkspaceStart } from "#src/runtime/workspace-start.ts";
import { createSubdomainPreviewBridge } from "#src/runtime/subdomain-preview-bridge.ts";
import type { PreviewOriginConfiguration } from "#src/runtime/preview-origin-contract.ts";
import type { SubdomainPreviewBridge } from "#src/runtime/subdomain-preview-bridge.ts";
import { ProjectHistoryPanel } from "#src/app/(authenticated)/projects/project-history-panel.tsx";
import type { ProjectHistoryState, RestoredProjectHead } from "#src/app/(authenticated)/projects/project-history-panel.tsx";
import { useProjectFileSearch } from "#src/app/(authenticated)/projects/use-project-file-search.ts";

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

type RuntimeFeature = typeof import("#src/runtime/runtime-adapter.ts");
const runtimeFeature = createRetryableLazyFeature<RuntimeFeature>(
  () => import("#src/runtime/runtime-adapter.ts")
);
type ResumeFeature = typeof import("#src/resume/project-content.ts");
const resumeFeature = createRetryableLazyFeature<ResumeFeature>(
  () => import("#src/resume/project-content.ts")
);
type SaveFeature = typeof import("#src/save/project-save.ts");
const saveFeature = createRetryableLazyFeature<SaveFeature>(() => import("#src/save/project-save.ts"));
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
  readonly initialHistoryState?: ProjectHistoryState;
  readonly resumeProjectContentLoader?: () => Promise<Pick<ResumeFeature, "resumeProjectContent">>;
  readonly runtimeFeatureLoader?: () => Promise<RuntimeFeature>;
  readonly workspaceScope: string;
}

export function ProjectIdeShell({ assetRevision, initialHistoryState, onProjectCommit, onProjectReload, previewBridgeFactory, previewConfiguration, project, projectEtag, resumeProjectContentLoader, runtimeFeatureLoader, workspaceScope }: Props) {
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
  const [serverSaveStatus, setServerSaveStatus] = useState("이 세션에서 아직 서버에 저장하지 않음");
  const [serverSaveFailure, setServerSaveFailure] = useState<"retry" | "stale">();
  const [recoveringAction, setRecoveringAction] = useState<RuntimeRecoveryActionKind>();
  const [confirmingWriterTakeover, setConfirmingWriterTakeover] = useState(false);
  const [isolatedPreviewUrl, setIsolatedPreviewUrl] = useState<string>();
  const [editorStatus, setEditorStatus] = useState("로컬 초안");
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
      setError("완전히 종료되지 않은 워크스페이스입니다. 프로젝트를 새로고침한 뒤 다시 시도하세요.");
      return;
    }
    setError(undefined);
    setServerSaveFailure(undefined);
    setIsStarting(true);
    setStartingSource(source);
    setResumeStatus(source === "saved" ? "현재 서버 저장본을 확인하는 중…" : "새 로컬 초안을 준비하는 중…");
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
      setResumeStatus(source === "saved" ? "검증 완료. 저장된 프로젝트를 여는 중…" : "시작 템플릿을 만드는 중…");
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
        ? "로컬 초안"
        : `서버 저장본 v${savedContent.descriptor.projectVersion} 복원됨`);
      setResumeStatus(savedContent === undefined
        ? "이 브라우저에 시작 템플릿을 준비했습니다."
        : `이 브라우저에 서버 저장본 v${savedContent.descriptor.projectVersion}을 준비했습니다.`);
      if (firstTextFile) selectFile(firstTextFile.path, materialized);
    } catch (caught) {
      const contentCode = projectContentErrorCode(caught);
      const runtimeCode = runtimeErrorCode(caught);
      setError(contentCode === null
        ? `브라우저 워크스페이스를 안전하게 시작하지 못했습니다.${runtimeCode ? ` (${runtimeCode})` : ""}`
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
      setError("바이너리 파일과 지원하지 않는 파일은 텍스트 편집기에서 열 수 없습니다.");
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
      setError("이 파일을 텍스트로 열 수 없습니다.");
    }
  }

  async function runCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const command = String(new FormData(form).get("command") ?? "").trim();
    if (!command) return;
    if (command.length > MAX_TERMINAL_COMMAND_CHARS) {
      setError("터미널 명령어가 너무 깁니다.");
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
      setError("터미널 명령을 완료하지 못했습니다.");
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
        setError("의존성 설치와 미리보기 실행을 완료하지 못했습니다.");
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
        setEditorStatus("패키지 캐시 삭제됨 · 로컬 초안 보존됨");
      } else if (kind === "resolve-writer-conflict") {
        setEditorStatus("편집 권한 획득 · 로컬 초안 보존됨");
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
        setError("복구를 완료하지 못했습니다. 로컬 초안은 유지되므로 작업을 확인한 뒤 다시 시도하세요.");
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
        if (!unmountedRef.current) setError("격리된 미리보기 연결을 안전하게 중지했습니다.");
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
          setError("격리된 미리보기 연결을 복구하지 못했습니다. 미리보기를 다시 실행하세요.");
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
      setEditorStatus(next.hmrState === "connected" ? "로컬 초안 저장됨 · HMR 적용됨" : "로컬 초안 저장됨 · 재시작 필요할 수 있음");
    } catch {
      setError("텍스트 변경사항을 안전하게 저장하지 못했습니다.");
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
    setServerSaveStatus("서버 저장 계획을 준비하는 중…");
    try {
      if (selectedPath && editorStatus === "저장하지 않은 로컬 변경") {
        const next = adapter.workspace.writeText(selectedPath, editorContent);
        setRuntime(next);
        setWorkspace(adapter.workspace.getState());
        previewBridgeRef.current?.hotUpdate(selectedPath);
        setEditorStatus("서버 저장을 위해 로컬 초안에 적용됨");
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
          setServerSaveStatus(`${serverSavePhaseLabel(progress.phase)}${percentage} · 로컬 초안 보존됨`);
        }
      });
      onProjectCommit?.({ projectEtag: result.projectEtag, projectVersion: result.projectVersion });
      setServerSaveStatus(result.snapshotCurrent
        ? `서버 저장 v${result.projectVersion} 완료 · 로컬 초안과 일치`
        : `서버 저장 v${result.projectVersion} 완료 · 더 최신 로컬 변경 남음`);
      setHasUnpublishedChanges(!result.snapshotCurrent);
    } catch (cause) {
      if (!controller.signal.aborted) {
        const stale = cause instanceof Error && "status" in cause && (cause as { status?: unknown }).status === 412;
        setServerSaveFailure(stale ? "stale" : "retry");
        setError(stale
          ? "저장 전에 서버 프로젝트가 변경되었습니다. 로컬 초안은 보존되므로 최신 프로젝트를 불러온 뒤 다시 시도하세요."
          : "서버 저장을 완료하지 못했습니다. 로컬 초안은 보존되므로 서비스가 준비되면 다시 시도하세요.");
        setServerSaveStatus("서버 저장 실패 · 로컬 초안 보존됨");
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
      setError("브라우저 워크스페이스가 일부 자원을 종료하지 못했습니다. 새로고침한 뒤 다시 시도하세요.");
      return;
    }
    setWorkspace(undefined);
    setSelectedPath(undefined);
    setEditorContent("");
    setTerminalOutput("");
    terminalTruncatedRef.current = false;
    setTerminalWasTruncated(false);
    setEditorStatus("로컬 초안");
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
      setError("복구 후 서버 프로젝트가 변경되었습니다. 로컬 초안은 보존되므로 기록을 새로고침한 뒤 교체하세요.");
      return;
    }

    const controller = new AbortController();
    replacementAbortRef.current = controller;
    setIsReplacingDraft(true);
    setError(undefined);
    setResumeStatus(`현재 로컬 초안을 변경하지 않고 복구된 서버 저장본 v${head.projectVersion}을 준비하는 중…`);
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
      setEditorStatus(`서버 저장본 v${head.projectVersion} 복구됨 · 사용자 선택으로 로컬 초안 교체됨`);
      setHasUnpublishedChanges(false);
      setResumeStatus(`검증된 서버 저장본 v${head.projectVersion}을 로컬 초안으로 열었습니다.`);

      const cleanup = await Promise.allSettled([
        previousBridge?.dispose() ?? Promise.resolve(),
        previousAdapter?.dispose() ?? Promise.resolve()
      ]);
      if (cleanup.some((result) => result.status === "rejected")) {
        setError("복구된 로컬 초안은 준비되었지만 이전 런타임이 완전히 종료되지 않았습니다. 미리보기 실행 전에 새로고침하세요.");
      }
      if (adapterRef.current.getState().localDraftAccess !== "writer") {
        try {
          setRuntime(await adapterRef.current.recovery.run("resolve-writer-conflict"));
        } catch {
          setError("편집 권한을 확보하지 못해 복구된 로컬 초안을 읽기 전용으로 열었습니다. 편집 전에 새로고침하세요.");
        }
      }
    } catch (cause) {
      await stagedAdapter?.dispose();
      if (!controller.signal.aborted) {
        setError(cause instanceof RestoredHeadChangedError
          ? "복구 저장본을 적용하기 전에 서버 프로젝트가 변경되었습니다. 이전 로컬 초안은 보존됩니다."
          : "복구된 서버 저장본을 안전하게 가져오고 검증해 열지 못했습니다. 이전 로컬 초안은 보존됩니다.");
        setResumeStatus("복구 저장본 교체 중지됨 · 이전 로컬 초안 보존됨");
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
  const hasUnsavedEditorChange = editorStatus === "저장하지 않은 로컬 변경";
  const selectedFileName = selectedPath?.split("/").at(-1);
  const editorLineCount = editorContent.length === 0 ? 1 : editorContent.split("\n").length;
  useUnsavedChangesGuard(hasUnpublishedChanges || hasUnsavedEditorChange);

  return (
    <section className={`project-ide-shell${isFocusMode ? " project-ide-shell--focus" : ""}`} aria-labelledby="project-ide-title">
      <header className="project-ide-header">
        <div className="project-ide-header__identity">
          <span className={`project-ide-runtime-dot project-ide-runtime-dot--${runtime.lifecycle}`} aria-hidden="true" />
          <div><p>브라우저 워크스페이스 · {runtimeLifecycleLabel(runtime.lifecycle)}</p><h3 id="project-ide-title" aria-label={`${project.name} 개발 편집기`}>{project.name}</h3></div>
          {hasWorkspace ? <span className={`project-ide-access project-ide-access--${canWriteLocalDraft ? "writer" : "reader"}`}>{canWriteLocalDraft ? "편집 가능" : "읽기 전용"}</span> : null}
        </div>
        {hasWorkspace ? <div className="project-ide-header__actions">
          <span className="project-ide-save-state" role="status" aria-live="polite"><i className={hasUnsavedEditorChange ? "is-dirty" : ""} aria-hidden="true" />{isReplacingDraft ? "복원본 준비 중 · 현재 초안 보존됨" : serverSaveStatus}</span>
          <Button type="button" size="sm" aria-pressed={isFocusMode} onClick={() => setIsFocusMode((current) => !current)}>{isFocusMode ? "패널 표시" : "집중 모드"}</Button>
          <Button aria-label="서버에 저장" type="button" size="sm" variant="primary" disabled={isServerSaving || isReplacingDraft || !projectEtag || !canWriteLocalDraft} onClick={() => void saveToServer()}>{isServerSaving ? "저장 중…" : "서버에 저장"}<kbd>⌘S</kbd></Button>
          <Button aria-label="워크스페이스 종료" type="button" size="sm" disabled={isReplacingDraft} onClick={() => {
            if (hasUnpublishedChanges || hasUnsavedEditorChange) setConfirmingWorkspaceStop(true);
            else void stopWorkspace();
          }}>종료</Button>
        </div> : null}
      </header>
      {error ? <div className="project-ide-message project-ide-message--error" role="alert"><strong>작업을 완료하지 못했습니다.</strong><span>{error}</span></div> : null}
      {serverSaveFailure ? <div className="project-ide-recovery-actions" aria-label="서버 저장 복구">{serverSaveFailure === "retry" ? <Button type="button" size="sm" disabled={isServerSaving || !canWriteLocalDraft} onClick={() => void saveToServer()}>서버 저장 다시 시도</Button> : <Button type="button" size="sm" onClick={() => onProjectReload?.()}>최신 프로젝트 다시 불러오기</Button>}</div> : null}
      {resumeStatus ? <p className="project-ide-message project-ide-message--status" role="status" aria-live="polite">{resumeStatus}</p> : null}
      {recoveryDiagnostics.length > 0 ? (
        <section className="project-ide-recovery" aria-label="워크스페이스 복구">
          <h4 className="m-0 text-sm font-semibold">워크스페이스 확인이 필요합니다</h4>
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
                    {recoveringAction === action.kind ? "복구 중…" : recoveryActionLabel(action.kind)}
                  </Button>
                ))}
              </div>
            </div>
          ))}
          {confirmingWriterTakeover ? (
            <div className="mt-3 rounded-md border border-danger p-3" role="alertdialog" aria-labelledby="writer-takeover-title">
              <p id="writer-takeover-title" className="m-0 text-sm font-semibold">다른 탭의 편집 권한을 가져올까요?</p>
              <p className="mb-3 mt-1 text-xs text-muted-foreground">다른 탭은 읽기 전용으로 전환됩니다. 저장하지 않은 편집 내용은 그대로 보이지만 이 탭에서만 로컬 초안을 쓸 수 있습니다.</p>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="primary" onClick={() => void executeRecovery("resolve-writer-conflict")}>이 탭에서 편집 시작</Button>
                <Button type="button" size="sm" onClick={() => setConfirmingWriterTakeover(false)}>취소</Button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
      {project.state !== "active" ? <p className="m-3 text-sm text-muted-foreground">보관된 프로젝트는 읽기 전용입니다. 버전과 복구 지점은 계속 확인할 수 있으며, 기록을 변경하거나 워크스페이스를 시작하려면 먼저 프로젝트를 복원하세요.</p> : null}
      {hasWorkspace ? (
        <div className="project-ide-workbench">
          <nav className="project-ide-files" aria-label="프로젝트 파일">
            <div className="project-ide-panel-heading"><div><span>탐색기</span><strong>파일</strong></div><kbd>⌘P</kbd></div>
            <label className="project-ide-file-search"><span className="sr-only">파일 검색</span><input ref={fileSearchRef} value={fileQuery} onChange={(event) => { setFileQuery(event.currentTarget.value); setFileListLimit(FILE_LIST_BATCH_SIZE); }} placeholder="파일 검색" autoComplete="off" /><span aria-hidden="true">{isFileSearchPending ? "…" : "⌕"}</span></label>
            <p className="project-ide-file-count" aria-live="polite">{visibleFiles.length}개 표시 · {matchingFiles.length}개 일치 · 전체 {workspace.files.length}개</p>
            {visibleFiles.length > 0 ? <ul>{visibleFiles.map((file) => <li key={file.path}><button type="button" title={file.path} aria-current={selectedPath === file.path ? "page" : undefined} onClick={() => selectFile(file.path)}><span className="project-ide-file-icon" aria-hidden="true">{file.kind === "text" ? "#" : "◆"}</span><span>{file.path}</span>{selectedPath === file.path && hasUnsavedEditorChange ? <i aria-label="저장하지 않은 변경 사항" /> : null}</button></li>)}</ul> : <p className="project-ide-files__empty">일치하는 파일이 없습니다.</p>}
            {hasMoreFiles ? <button className="project-ide-files__more" type="button" onClick={() => setFileListLimit((current) => current + FILE_LIST_BATCH_SIZE)}>다음 {Math.min(FILE_LIST_BATCH_SIZE, matchingFiles.length - visibleFiles.length)}개 보기</button> : null}
          </nav>
          <section className="project-ide-editor" aria-label="텍스트 편집기">
            <div className="project-ide-editor__tabs">{selectedPath ? <div className="is-active"><span className="project-ide-file-icon" aria-hidden="true">#</span><strong>{selectedFileName}</strong>{hasUnsavedEditorChange ? <i aria-label="저장하지 않은 변경 사항" /> : <button type="button" aria-label={`${selectedFileName} 닫기`} onClick={() => { setSelectedPath(undefined); setEditorContent(""); }}>×</button>}</div> : <span>파일을 선택하세요</span>}</div>
            <div className="project-ide-editor__breadcrumb"><span>{project.name}</span>{selectedPath?.split("/").map((segment) => <span key={segment}>{segment}</span>)}</div>
            {selectedPath ? <textarea className="project-ide-editor__input" aria-label={`${selectedPath} 편집기`} spellCheck={false} readOnly={!canWriteLocalDraft} value={editorContent} onChange={(event) => { setEditorContent(event.currentTarget.value); setEditorStatus("저장하지 않은 로컬 변경"); setHasUnpublishedChanges(true); }} /> : <div className="project-ide-editor__empty"><span aria-hidden="true">⌘</span><strong>편집할 파일을 선택하세요</strong><p>왼쪽 파일 목록에서 선택하거나 <kbd>⌘P</kbd>로 빠르게 찾을 수 있습니다.</p></div>}
            <div className="project-ide-editor__status"><span><i className={hasUnsavedEditorChange ? "is-dirty" : ""} aria-hidden="true" />{editorStatus}</span><span>{editorLineCount}줄 · {editorContent.length}자 · UTF-8</span><Button aria-label="로컬 초안에 적용" type="button" size="sm" disabled={!selectedPath || isSaving || !canWriteLocalDraft} onClick={saveSelectedFile}>{isSaving ? "적용 중…" : "로컬 초안에 적용"}</Button></div>
          </section>
          <aside className="project-ide-utility">
            <div className="project-ide-utility__tabs" role="tablist" aria-label="실행 도구"><button type="button" role="tab" aria-selected={utilityPanel === "preview"} onClick={() => setUtilityPanel("preview")}>미리보기{runtime.hmrState === "connected" ? <i aria-hidden="true" /> : null}</button><button type="button" role="tab" aria-selected={utilityPanel === "terminal"} onClick={() => setUtilityPanel("terminal")}>터미널{runtime.terminalProcessCount > 0 ? <span>{runtime.terminalProcessCount}</span> : null}</button></div>
            <section className="project-ide-preview" aria-label="미리보기" data-preview-url={isolatedPreviewUrl} hidden={utilityPanel !== "preview"}><div className="project-ide-preview__toolbar"><div><strong>실시간 미리보기</strong><span>{workflowPhaseLabel(runtime.workflowPhase)} · HMR {hmrStateLabel(runtime.hmrState)}</span></div>{hasIsolatedPreview ? <span className="project-ide-live"><i aria-hidden="true" /> 실행 중</span> : <Button aria-label="미리보기 실행" type="button" size="sm" variant="primary" disabled={isRunningPreview} onClick={() => void runPreview()}>{isRunningPreview ? "설치 중…" : "미리보기 실행"}</Button>}</div>{hasIsolatedPreview ? <iframe ref={(frame) => previewBridgeRef.current?.attach(frame?.contentWindow ?? null)} title={`${project.name} 미리보기`} src={isolatedPreviewUrl} sandbox="allow-scripts allow-same-origin" allow="cross-origin-isolated" referrerPolicy="no-referrer" /> : previewConfiguration.status === "disabled" ? <div className="project-ide-utility__empty" role="status"><strong>미리보기를 사용할 수 없습니다.</strong><p>{previewConfiguration.message} 동일 출처 미리보기는 보안을 위해 비활성화되어 있습니다.</p></div> : runtime.previewUrl ? <div className="project-ide-utility__empty" role="status"><strong>격리된 연결을 준비하고 있습니다.</strong><p>격리된 미리보기 연결이 아직 준비되지 않았습니다. 동일 출처 미리보기는 비활성화되어 있습니다.</p></div> : <div className="project-ide-utility__empty"><span aria-hidden="true">▷</span><strong>실행 결과를 바로 확인하세요</strong><p>의존성을 설치하고 개발 서버를 시작합니다.</p></div>}</section>
            <section className="project-ide-terminal" aria-label="터미널" hidden={utilityPanel !== "terminal"}><div className="project-ide-terminal__toolbar"><strong>터미널</strong><span>{terminalWasTruncated ? "최근 64KB만 표시" : runtime.terminalProcessCount > 0 ? `${runtime.terminalProcessCount}개 프로세스 실행 중` : "대기 중"}</span></div><pre aria-live="polite">{terminalOutput || "브라우저 안에서 제한된 명령을 실행할 수 있습니다."}</pre><form onSubmit={runCommand}><label className="sr-only" htmlFor={`terminal-command-${project.id}`}>터미널 명령어</label><span aria-hidden="true">›</span><input id={`terminal-command-${project.id}`} name="command" placeholder="명령어 입력" autoComplete="off" maxLength={MAX_TERMINAL_COMMAND_CHARS} /><Button type="submit" size="sm">실행</Button></form></section>
          </aside>
        </div>
      ) : <div className="project-ide-start"><div className="project-ide-start__copy"><span className="project-ide-start__mark" aria-hidden="true">N</span><p className="eyebrow">브라우저 개발 환경</p><h4>코드를 열고,<br />바로 실행하세요.</h4><p>서버에 저장된 작업을 안전하게 이어가거나, 새로운 React 템플릿으로 바로 시작하세요.</p></div><div className="project-ide-start__actions"><button aria-label="저장된 프로젝트 이어서 열기" type="button" disabled={isStarting || project.state !== "active"} onClick={() => void startWorkspace("saved")}><span aria-hidden="true">↗</span><strong>{startingSource === "saved" ? "불러오는 중…" : "저장된 프로젝트 이어서 열기"}</strong><small>무결성을 확인한 최신 서버 저장본을 엽니다.</small></button><button aria-label="템플릿으로 워크스페이스 시작" type="button" disabled={isStarting || project.state !== "active"} onClick={() => void startWorkspace("template")}><span aria-hidden="true">＋</span><strong>{startingSource === "template" ? "시작하는 중…" : "새 템플릿으로 시작"}</strong><small>Vite + React 기본 구성으로 로컬 초안을 만듭니다.</small></button></div><p className="project-ide-start__safety">브라우저의 로컬 초안은 명시적으로 서버에 저장하기 전까지 기존 서버 버전을 덮어쓰지 않습니다.</p></div>}
      <details className="project-ide-history" open>
        <summary><span>버전과 복구</span><small>서버 저장 이력과 체크포인트</small></summary>
        <ProjectHistoryPanel
          hasLocalDraft={hasWorkspace}
          initialState={initialHistoryState}
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

function runtimeLifecycleLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    idle: "대기",
    booting: "시작 중",
    ready: "준비됨",
    stopping: "종료 중",
    stopped: "종료됨",
    failed: "오류"
  };
  return labels[value] ?? value;
}

function workflowPhaseLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    idle: "대기",
    installing: "설치 중",
    starting: "서버 시작 중",
    running: "실행 중",
    failed: "오류"
  };
  return labels[value] ?? value;
}

function hmrStateLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    idle: "대기",
    connecting: "연결 중",
    connected: "연결됨",
    disconnected: "연결 끊김",
    failed: "오류"
  };
  return labels[value] ?? value;
}

function serverSavePhaseLabel(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    planning: "저장 계획 수립 중",
    creating: "저장본 생성 중",
    uploading: "업로드 중",
    committing: "서버에 반영 중",
    reconciling: "처리 결과 확인 중"
  };
  return labels[value] ?? value;
}

function recoveryActionLabel(kind: RuntimeRecoveryActionKind): string {
  if (kind === "clear-cache") return "패키지 캐시 비우기";
  if (kind === "reset-runtime") return "런타임 초기화";
  if (kind === "resolve-writer-conflict") return "편집 권한 가져오기";
  if (kind === "restart-dev-server") return "개발 서버 다시 시작";
  return "미리보기 다시 시도";
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
    return "세션이 만료되었습니다. 다시 로그인한 뒤 프로젝트를 여세요. 로컬 초안은 교체하지 않았습니다.";
  }
  if (code === "RESUME_NOT_SAVED") {
    return "이 프로젝트에는 현재 서버 저장본이 없습니다. 템플릿에서 시작해 첫 로컬 초안을 만드세요.";
  }
  if (code === "RESUME_CONTENT_UNAVAILABLE") {
    return "현재 서버 저장본을 이 계정에서 더 이상 사용할 수 없습니다. 로컬 초안은 교체하지 않았습니다.";
  }
  if (code === "RESUME_LIMIT_EXCEEDED") {
    return "현재 서버 저장본이 브라우저 워크스페이스 제한을 초과합니다. 어떤 파일도 열지 않았습니다.";
  }
  if (code === "RESUME_INTEGRITY_FAILED") {
    return "현재 서버 저장본의 무결성 검증에 실패했습니다. 파일은 열지 않았으므로 다시 시도하거나 관리자에게 저장소 점검을 요청하세요.";
  }
  if (code === "RESUME_ABORTED") return "프로젝트 열기를 취소했습니다. 로컬 초안은 교체하지 않았습니다.";
  return "현재 서버 저장본을 열지 못했습니다. 로컬 초안은 교체하지 않았으므로 서비스가 준비되면 다시 시도하세요.";
}

class RestoredHeadChangedError extends Error {}
