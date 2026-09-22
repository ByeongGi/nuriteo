export type {
  PreviewWorkflowController,
  PreviewWorkflowEvent,
  PreviewWorkflowLastError,
  PreviewWorkflowPhase,
  PreviewWorkflowSnapshot,
  PreviewWorkflowUiDiagnostic
} from "@cargo-container/preview-service";

export type {
  ProjectWorkspaceEditorFile,
  ProjectWorkspaceTreeNode,
  SupportedPackageManager,
  TemplateId
} from "@cargo-container/browser-host";

export type DockTab = "terminal" | "diagnostics";

export interface PreviewServiceApi {
  controller: import("@cargo-container/preview-service").PreviewWorkflowController;
  loadTemplate: (id?: import("@cargo-container/browser-host").TemplateId) => import("@cargo-container/preview-service").PreviewWorkflowSnapshot;
  importZipFile: (file: Blob) => Promise<import("@cargo-container/preview-service").PreviewWorkflowSnapshot>;
  importGitHub: (url: string) => Promise<import("@cargo-container/preview-service").PreviewWorkflowSnapshot>;
  exportZip: () => Uint8Array;
  setPackageManagerOverride: (value: import("@cargo-container/browser-host").SupportedPackageManager | null) => void;
  runPreview: () => Promise<import("@cargo-container/preview-service").PreviewWorkflowSnapshot>;
  restartDev: () => Promise<import("@cargo-container/preview-service").PreviewWorkflowSnapshot>;
  reconnectHmr: () => Promise<unknown>;
  runBuild: () => Promise<import("@cargo-container/preview-service").PreviewWorkflowSnapshot>;
  clearPackageCache: () => { freedBytes: number; evicted: number };
  resolveWriterConflict: () => void;
  runRecoveryAction: (kind: string) => Promise<unknown>;
  simulateQuotaPressure: (bytes?: number) => void;
  snapshot: () => import("@cargo-container/preview-service").PreviewWorkflowSnapshot;
  openFile: (path: string) => void;
  editCurrentFile: (data: string) => void;
  saveCurrentFile: () => void;
}

declare global {
  // eslint-disable-next-line no-var
  var __previewService: PreviewServiceApi;
}

export {};
