import type { Project } from "@nuriteo/api-client";
import type { CSSProperties, Dispatch, FormEvent, PointerEvent as ReactPointerEvent, SetStateAction } from "react";

import type { EditorThemePreference } from "@/projects/_utils/project-editor-theme.ts";
import type { ProjectContentSearchMatch } from "@/projects/_hooks/use-project-file-search.ts";
import type { ProjectTerminalSession } from "@/projects/_hooks/use-project-terminal-sessions.ts";
import type { EditorDraftState, EditorOpenMode, EditorTabs } from "@/projects/studio/_utils/editor-tabs.ts";
import type { StudioConsoleEntry } from "@/projects/studio/_utils/preview-console.ts";
import { ideStyles } from "@/projects/studio/_components/studio-ide-styles.ts";
import type {
  RuntimeAdapter,
  RuntimeRecoveryActionKind,
  RuntimeViewState,
  RuntimeWorkspaceFile,
  RuntimeWorkspaceState
} from "#src/runtime/runtime-adapter.ts";
import type { PreviewHistory } from "#src/runtime/preview-address.ts";
import type { PreviewOriginConfiguration } from "#src/runtime/preview-origin-contract.ts";
import type { PreviewChangeKind, SubdomainPreviewBridge } from "#src/runtime/subdomain-preview-bridge.ts";

export const EMPTY_RUNTIME_STATE: RuntimeViewState = {
  generation: 0,
  lifecycle: "idle",
  projectId: null,
  workflowPhase: "idle",
  hmrState: "idle",
  previewUrl: null,
  ports: [],
  processes: [],
  diagnostics: [],
  localDraftAccess: "none",
  terminalProcessCount: 0,
  serverLogs: []
};
export const MAX_TERMINAL_COMMAND_CHARS = 2_048;
export const RUNTIME_BOOT_TIMEOUT_MS = 10_000;
export const RUNTIME_RELAY_TIMEOUT_MS = 10_000;
export const RUNTIME_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
export const PREVIEW_WINDOW_CONNECT_TIMEOUT_MS = 3_000;
export const PREVIEW_WINDOW_CLOSED_POLL_MS = 1_000;
export const FILE_LIST_BATCH_SIZE = 200;
export const PREVIEW_APPLY_DELAY_MS = 400;
export const EMPTY_WORKSPACE_FILES: readonly RuntimeWorkspaceFile[] = [];
export const INITIAL_SERVER_SAVE_STATUS = "이 세션에서 아직 서버에 저장하지 않음";

export type SidebarPanel = "files" | "search";
export type BottomPanel = "console" | "ports" | "problems" | "processes" | "output" | "terminal";
export type FileOperation = "create" | "directory" | "rename";

export interface EditorDiagnostic {
  readonly column: number;
  readonly line: number;
  readonly message: string;
  readonly severity: number;
}

export interface EditorPositionRequest {
  readonly column: number;
  readonly line: number;
  readonly requestId: number;
}

export interface StudioMutableRef<T> {
  current: T;
}

export interface StudioTerminalController {
  readonly activeSession: ProjectTerminalSession;
  readonly activeSessionId: number;
  readonly sessions: readonly ProjectTerminalSession[];
  append(sessionId: number, value: string): void;
  clear(sessionId?: number): void;
  create(): number;
  reset(): void;
  setActiveSessionId(sessionId: number): void;
}

type SetState<T> = Dispatch<SetStateAction<T>>;
type StudioIdeCss = ReturnType<typeof ideStyles>;
type PreviewBridgeFactory = typeof import("#src/runtime/subdomain-preview-bridge.ts").createSubdomainPreviewBridge;
type ResumeLoader = () => Promise<Pick<typeof import("#src/resume/project-content.ts"), "resumeProjectContent">>;
type RuntimeLoader = () => Promise<typeof import("#src/runtime/runtime-adapter.ts")>;

export interface StudioShellData {
  readonly activeBufferDirty: boolean;
  readonly adapterRef: StudioMutableRef<RuntimeAdapter | undefined>;
  readonly appliedEditorContentRef: StudioMutableRef<string>;
  readonly appliedSplitContentRef: StudioMutableRef<string>;
  readonly assetRevision: string | undefined;
  readonly bottomPanel: BottomPanel;
  readonly bottomPanelHeight: number;
  readonly canWriteLocalDraft: boolean;
  readonly confirmingFileDelete: boolean;
  readonly confirmingWorkspaceStop: boolean;
  readonly confirmingWriterTakeover: boolean;
  readonly contentSearchError: string | undefined;
  readonly contentSearchMatches: readonly ProjectContentSearchMatch[];
  readonly css: StudioIdeCss;
  readonly editorContent: string;
  readonly editorContentRef: StudioMutableRef<string>;
  readonly editorDiagnostics: readonly EditorDiagnostic[];
  readonly editorDrafts: EditorDraftState;
  readonly editorDraftsRef: StudioMutableRef<EditorDraftState>;
  readonly editorFormatRequestId: number | undefined;
  readonly editorLineCount: number;
  readonly editorPositionRequest: EditorPositionRequest | undefined;
  readonly editorStatus: string;
  readonly editorTabs: EditorTabs;
  readonly editorTabsRef: StudioMutableRef<EditorTabs>;
  readonly editorThemePreference: EditorThemePreference;
  readonly error: string | undefined;
  readonly explorerFiles: readonly RuntimeWorkspaceFile[];
  readonly fileListLimit: number;
  readonly fileOperation: FileOperation | undefined;
  readonly fileOperationValue: string;
  readonly fileQuery: string;
  readonly fileSearchRef: StudioMutableRef<HTMLInputElement | null>;
  readonly hasIsolatedPreview: boolean;
  readonly hasMoreFiles: boolean;
  readonly hasUnpublishedChanges: boolean;
  readonly hasUnsavedEditorChange: boolean;
  readonly hasWorkspace: boolean;
  readonly isContentSearchPending: boolean;
  readonly isEditorSplit: boolean;
  readonly isFocusMode: boolean;
  readonly isPreviewOpen: boolean;
  readonly isRunningPreview: boolean;
  readonly isSaving: boolean;
  readonly isServerSaving: boolean;
  readonly isSidebarOpen: boolean;
  readonly isStarting: boolean;
  readonly isTerminalOpen: boolean;
  readonly isTerminalOpenRef: StudioMutableRef<boolean>;
  readonly isolatedPreviewUrl: string | undefined;
  readonly manifestAbortRef: StudioMutableRef<AbortController | null>;
  readonly matchFileCase: boolean;
  readonly matchingFiles: readonly RuntimeWorkspaceFile[];
  readonly onProjectCommit: ((result: { readonly projectEtag: string; readonly projectVersion: number }) => void) | undefined;
  readonly onProjectReload: (() => void) | undefined;
  readonly openPaths: readonly string[];
  readonly packageSyncGenerationRef: StudioMutableRef<number>;
  readonly pendingDeletePath: string | undefined;
  readonly previewAddress: string;
  readonly previewAddressEditingRef: StudioMutableRef<boolean>;
  readonly previewBridgeFactory: PreviewBridgeFactory | undefined;
  readonly previewBridgeOperationRef: StudioMutableRef<number>;
  readonly previewBridgeRef: StudioMutableRef<SubdomainPreviewBridge | undefined>;
  readonly previewCancelRequestedRef: StudioMutableRef<boolean>;
  readonly previewConfiguration: PreviewOriginConfiguration;
  readonly previewConsole: readonly StudioConsoleEntry[];
  readonly previewConsoleIdRef: StudioMutableRef<number>;
  readonly previewFrameRef: StudioMutableRef<HTMLIFrameElement | null>;
  readonly previewHistory: PreviewHistory;
  readonly previewRecoveryRef: StudioMutableRef<Promise<void> | null>;
  readonly previewRefreshFailed: boolean;
  readonly previewWidth: number;
  readonly previewWindowBridgesRef: StudioMutableRef<Set<SubdomainPreviewBridge>>;
  readonly previewWindowDisposersRef: StudioMutableRef<Set<() => void>>;
  readonly previousServerLogsRef: StudioMutableRef<readonly string[]>;
  readonly project: Project;
  readonly projectEtag: string | undefined;
  readonly quickOpenIndex: number;
  readonly quickOpenQuery: string;
  readonly readWorkspaceText: (path: string) => string;
  readonly recoveringAction: RuntimeRecoveryActionKind | undefined;
  readonly recoveryDiagnostics: RuntimeViewState["diagnostics"];
  readonly replaceQuery: string;
  readonly resumeProjectContentLoader: ResumeLoader | undefined;
  readonly resumeStatus: string | undefined;
  readonly runtime: RuntimeViewState;
  readonly runtimeFeatureLoader: RuntimeLoader | undefined;
  readonly saveAbortRef: StudioMutableRef<AbortController | null>;
  readonly selectedFileName: string | undefined;
  readonly selectedPath: string | undefined;
  readonly selectedPathRef: StudioMutableRef<string | undefined>;
  readonly serverSaveFailure: "retry" | "stale" | undefined;
  readonly serverSaveStatus: string;
  readonly setBottomPanel: SetState<BottomPanel>;
  readonly setBottomPanelHeight: SetState<number>;
  readonly setConfirmingFileDelete: SetState<boolean>;
  readonly setConfirmingWorkspaceStop: SetState<boolean>;
  readonly setConfirmingWriterTakeover: SetState<boolean>;
  readonly setEditorContent: SetState<string>;
  readonly setEditorDiagnostics: SetState<readonly EditorDiagnostic[]>;
  readonly setEditorDrafts: SetState<EditorDraftState>;
  readonly setEditorFormatRequestId: SetState<number | undefined>;
  readonly setEditorPositionRequest: SetState<EditorPositionRequest | undefined>;
  readonly setEditorStatus: SetState<string>;
  readonly setEditorTabs: SetState<EditorTabs>;
  readonly setEditorThemePreference: SetState<EditorThemePreference>;
  readonly setError: SetState<string | undefined>;
  readonly setFileListLimit: SetState<number>;
  readonly setFileOperation: SetState<FileOperation | undefined>;
  readonly setFileOperationValue: SetState<string>;
  readonly setFileQuery: SetState<string>;
  readonly setHasUnpublishedChanges: SetState<boolean>;
  readonly setIsEditorSplit: SetState<boolean>;
  readonly setIsFocusMode: SetState<boolean>;
  readonly setIsPreviewOpen: SetState<boolean>;
  readonly setIsRunningPreview: SetState<boolean>;
  readonly setIsSaving: SetState<boolean>;
  readonly setIsServerSaving: SetState<boolean>;
  readonly setIsSidebarOpen: SetState<boolean>;
  readonly setIsStarting: SetState<boolean>;
  readonly setIsTerminalOpen: SetState<boolean>;
  readonly setIsolatedPreviewUrl: SetState<string | undefined>;
  readonly setMatchFileCase: SetState<boolean>;
  readonly setPendingDeletePath: SetState<string | undefined>;
  readonly setPreviewAddress: SetState<string>;
  readonly setPreviewConsole: SetState<readonly StudioConsoleEntry[]>;
  readonly setPreviewHistory: SetState<PreviewHistory>;
  readonly setPreviewRefreshFailed: SetState<boolean>;
  readonly setPreviewWidth: SetState<number>;
  readonly setQuickOpenIndex: SetState<number>;
  readonly setQuickOpenQuery: SetState<string>;
  readonly setRecoveringAction: SetState<RuntimeRecoveryActionKind | undefined>;
  readonly setReplaceQuery: SetState<string>;
  readonly setResumeStatus: SetState<string | undefined>;
  readonly setRuntime: SetState<RuntimeViewState>;
  readonly setSelectedPath: SetState<string | undefined>;
  readonly setServerSaveFailure: SetState<"retry" | "stale" | undefined>;
  readonly setServerSaveStatus: SetState<string>;
  readonly setSidebarPanel: SetState<SidebarPanel>;
  readonly setSidebarWidth: SetState<number>;
  readonly setSplitContent: SetState<string>;
  readonly setSplitPath: SetState<string | undefined>;
  readonly setUseFileRegularExpression: SetState<boolean>;
  readonly setWorkspace: SetState<RuntimeWorkspaceState | undefined>;
  readonly sidebarPanel: SidebarPanel;
  readonly sidebarWidth: number;
  readonly splitContent: string;
  readonly splitContentRef: StudioMutableRef<string>;
  readonly splitPath: string | undefined;
  readonly splitPathRef: StudioMutableRef<string | undefined>;
  readonly suppressEditorChangeRef: StudioMutableRef<number>;
  readonly suppressSplitChangeRef: StudioMutableRef<number>;
  readonly terminal: StudioTerminalController;
  readonly totalContentSearchMatches: number;
  readonly unmountedRef: StudioMutableRef<boolean>;
  readonly unsubscribeRef: StudioMutableRef<() => void>;
  readonly useFileRegularExpression: boolean;
  readonly utilityLayout: string | undefined;
  readonly visibleFiles: readonly RuntimeWorkspaceFile[];
  readonly workbenchLayout: string | undefined;
  readonly workbenchRef: StudioMutableRef<HTMLDivElement | null>;
  readonly workbenchStyle: CSSProperties;
  readonly workspace: RuntimeWorkspaceState | undefined;
  readonly workspaceScope: string;
  readonly workspaceStartOperationRef: StudioMutableRef<number>;
  readonly isQuickOpenOpen: boolean;
  readonly setIsQuickOpenOpen: SetState<boolean>;
}

export interface StudioShellSession extends StudioShellData {
  applyDraftChange: (path: string, content: string) => Promise<void>;
  attachPreviewFrame: (frame: HTMLIFrameElement | null) => void;
  beginBottomPanelResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  beginCreate: (directoryPath?: string) => void;
  beginCreateDirectory: (directoryPath?: string) => void;
  beginFileOperation: (operation: FileOperation) => void;
  beginHorizontalResize: (panel: "files" | "preview", event: ReactPointerEvent<HTMLDivElement>) => void;
  beginRename: (path: string) => void;
  cancelRunningPreview: () => void;
  changeEditorThemePreference: (value: unknown) => void;
  closeAllFiles: () => void;
  closeFile: (path: string) => void;
  closeSavedFiles: () => void;
  closeSplit: () => void;
  commitFileOperation: (event: FormEvent<HTMLFormElement>) => void;
  copyExplorerPath: (path: string) => void;
  createPreviewBridge: (internalPreviewUrl: string) => Promise<SubdomainPreviewBridge>;
  deleteSelectedFile: () => void;
  executeRecovery: (kind: RuntimeRecoveryActionKind) => Promise<void>;
  flushEditorPath: (adapter: RuntimeAdapter, path: string) => void;
  flushPendingDrafts: (adapter: RuntimeAdapter) => void;
  handlePrimaryEditorChange: (nextValue: string) => void;
  handleSplitEditorChange: (nextValue: string) => void;
  hotUpdatePreviews: (path: string, changeKind?: PreviewChangeKind) => void;
  moveExplorerPath: (from: string, targetDirectory: string) => void;
  movePreview: (direction: -1 | 1) => void;
  noteEditorDraftChange: (path: string, content: string) => void;
  openInSplit: (path: string) => void;
  openPreviewWindow: () => void;
  persistSelectedEditorToDraft: (adapter?: RuntimeAdapter) => void;
  persistSplitDraft: (adapter?: RuntimeAdapter) => void;
  postPreviewNavigation: (path: string) => void;
  readBufferedText: (adapter: RuntimeAdapter, path: string) => string;
  recordPreviewConsole: (entry: { level: StudioConsoleEntry["level"]; message: string; stack: string }, source?: StudioConsoleEntry["source"]) => void;
  recoverPreview: (staleBridge: SubdomainPreviewBridge, internalPreviewUrl: string) => void;
  refreshPreview: () => void;
  releaseAdapter: () => Promise<void>;
  replaceInProject: () => void;
  requestDelete: (path: string) => void;
  runCommand: (command: string) => Promise<void>;
  runPreview: () => Promise<void>;
  saveSelectedFile: () => void;
  saveToServer: () => Promise<void>;
  selectFile: (path: string, currentWorkspace?: RuntimeWorkspaceState, mode?: EditorOpenMode) => void;
  showEditorText: (content: string) => void;
  showSplitText: (content: string) => void;
  startPreview: (adapter: RuntimeAdapter) => Promise<void>;
  startWorkspace: () => Promise<void>;
  stopPreviewPort: (port: number) => Promise<void>;
  stopTerminalProcess: (terminalId: string) => void;
  stopWorkspace: () => Promise<void>;
  submitPreviewAddress: (event: FormEvent<HTMLFormElement>) => void;
  swapPreviewBridge: (adapter: RuntimeAdapter, internalPreviewUrl: string, expectedBridge?: SubdomainPreviewBridge) => Promise<boolean>;
  toggleSplit: () => void;
}

export function createStudioShellSession(data: StudioShellData): StudioShellSession {
  return data as StudioShellSession;
}
