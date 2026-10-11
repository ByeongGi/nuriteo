import type {
  ProjectWorkspaceEditorBridge,
  ProjectWorkspaceStore
} from "../../browser-host/src/storage/index.ts";
import type {
  MaterializedProject,
  ProjectHealthReport,
  SupportedPackageManager,
  TemplateId
} from "../../browser-host/src/onboarding/index.ts";
import type {
  NextProductWorkflow,
  NextProductBuildResult,
  NextProductInstallResult
} from "../../node-runtime/src/frameworks/next-workflow.ts";
import type {
  ViteProductWorkflow,
  ViteProductBuildResult,
  ViteProductInstallResult,
  ViteProductPackageManager,
  ViteProductTemplate
} from "../../node-runtime/src/frameworks/vite-workflow.ts";
import type {
  HmrClientSnapshot,
  HmrClientState,
  PreviewRecoveryAction,
  PreviewSession
} from "../../preview/src/index.ts";
import type { RuntimeRecoveryActionKind } from "../../browser-host/src/observability/recovery-actions.ts";
import type {
  HostProcessStatus,
  HostProcessTable
} from "../../browser-host/src/process/index.ts";
import type { TerminalRunResult } from "../../node-runtime/src/shell/index.ts";

export type ProductWorkflow = ViteProductWorkflow | NextProductWorkflow;
export type ProductInstallResult = ViteProductInstallResult | NextProductInstallResult;
export type ProductBuildResult = ViteProductBuildResult | NextProductBuildResult;

export type FileSystemTree = {
  [name: string]: { file: { contents: string } } | { directory: FileSystemTree };
};

export interface PreviewProjectFile {
  readonly path: string;
  readonly kind: "text" | "binary";
  readonly bytes: Uint8Array;
}

export type PreviewProjectFileInput = PreviewProjectFile | {
  readonly path: string;
  readonly content: string;
};

export interface PreviewChangeStatus {
  dirty: string[];
  untrackedHint: string;
  hasGitMarker: boolean;
}

export const PHASES = Object.freeze({
  idle: "idle",
  templateLoaded: "template_loaded",
  installing: "installing",
  installed: "installed",
  startingDev: "starting_dev",
  previewReady: "preview_ready",
  hmrConnected: "hmr_connected",
  building: "building",
  built: "built",
  failed: "failed"
} as const);

export type PreviewWorkflowPhase = (typeof PHASES)[keyof typeof PHASES];

export type PreviewWorkflowEventType =
  | "log"
  | "phase"
  | "error"
  | "editor-change"
  | "hmr-update"
  | "diagnostic"
  | "import-failed"
  | "template-loaded"
  | "override"
  | "hmr"
  | "preview-ready"
  | "build";

export interface PreviewWorkflowLastError {
  source: string;
  message: string;
  stack?: string;
}

export interface PreviewWorkflowUiDiagnostic {
  code?: string;
  message: string;
  level?: string;
  file?: string;
  stack?: string;
  recoveryActions?: Array<{
    kind: PreviewRecoveryAction["kind"] | RuntimeRecoveryActionKind | (string & {});
    label: string;
  }>;
}

export interface PreviewWorkflowSnapshot {
  phase: PreviewWorkflowPhase;
  projectId: string | null;
  manager: ViteProductPackageManager | SupportedPackageManager | null;
  template: ViteProductTemplate | "next-app" | null;
  source: MaterializedProject["source"] | null;
  health: ProjectHealthReport | null;
  packageManagerOverride: SupportedPackageManager | null;
  previewUrl: string | null;
  hmrState: HmrClientState | "idle";
  install: ProductInstallResult | null;
  build: ProductBuildResult | null;
  lastError: PreviewWorkflowLastError | null;
  diagnostics: PreviewWorkflowUiDiagnostic[];
  logs: string[];
  editor: ProjectWorkspaceEditorBridge | null;
  project: ProjectWorkspaceStore | null;
  workflow: ProductWorkflow | null;
  session: PreviewSession | null;
}

export interface PreviewWorkflowEvent {
  type: PreviewWorkflowEventType;
  detail: Record<string, unknown>;
  snapshot: PreviewWorkflowSnapshot;
}

export type PreviewWorkflowListener = (event: PreviewWorkflowEvent) => void;

export interface PreviewWorkflowController {
  on(listener: PreviewWorkflowListener): () => boolean;
  getSnapshot(): PreviewWorkflowSnapshot;
  loadViteReactTemplate(options?: { label?: string }): PreviewWorkflowSnapshot;
  loadTemplate(templateId?: TemplateId, options?: { label?: string }): PreviewWorkflowSnapshot;
  importZipFile(file: Blob): Promise<PreviewWorkflowSnapshot>;
  importGitHub(url: string): Promise<PreviewWorkflowSnapshot>;
  importSnapshot(snapshot: Blob | Uint8Array | ArrayBuffer | string): Promise<PreviewWorkflowSnapshot>;
  importProjectFiles(files: readonly PreviewProjectFileInput[], name?: string): PreviewWorkflowSnapshot;
  exportProjectFiles(): readonly PreviewProjectFile[];
  bootSnapshot(snapshot: Blob | Uint8Array | ArrayBuffer | string): Promise<PreviewWorkflowSnapshot>;
  exportZip(): Uint8Array;
  exportSnapshot(): Uint8Array;
  exportTreeJson(path?: string): FileSystemTree;
  exportPathZip(relativePath: string): Uint8Array;
  setPackageManagerOverride(value: SupportedPackageManager | null | ""): void;
  setPreviewErrorBridge(enabled: boolean): void;
  getChangeStatus(): PreviewChangeStatus;
  saveTextFile(path: string, data: string): PreviewWorkflowSnapshot;
  runPreview(): Promise<PreviewWorkflowSnapshot>;
  restartDev(): Promise<PreviewWorkflowSnapshot>;
  reconnectHmr(): Promise<HmrClientSnapshot>;
  runBuild(): Promise<PreviewWorkflowSnapshot>;
  stopPreviewPort(port?: number): boolean;
  ensureServiceWorker(): Promise<ServiceWorkerRegistration>;
  clearPackageCache(): { freedBytes: number; evicted: number };
  resolveWriterConflict(): void;
  runRecoveryAction(kind: RuntimeRecoveryActionKind | string): Promise<unknown>;
  simulateQuotaPressure(bytes?: number): void;
  runShellCommand(command: string, terminalId?: string, onOutput?: (chunk: { stream: "stdout" | "stderr"; data: string }) => void): Promise<TerminalRunResult>;
  writeShellInput(data: string, terminalId?: string): boolean;
  resizeShell(cols: number, rows: number, terminalId?: string): void;
  signalShell(signal?: "SIGINT" | "SIGTERM" | "SIGKILL", terminalId?: string): boolean;
  closeShell(terminalId: string): boolean;
  listShellProcesses(): Array<{
    pid: number;
    generation?: number;
    terminalId: string;
    command: string;
    argv?: string[];
    cwd: string;
    status: "running" | HostProcessStatus;
    terminalSize?: { cols: number; rows: number };
  }>;
  cancelShellCommand(terminalId?: string): boolean;
  dispose(): void;
  log(line: unknown): void;
}

export interface PreviewWorkflowControllerOptions {
  previewServiceWorkerUrl?: string | URL;
  workspaceProjectId?: string;
  workspaceRoot?: string;
  ttlMs?: number;
  relayTimeoutMs?: number;
  previewPort?: number;
  terminalProcessTable?: HostProcessTable;
}
