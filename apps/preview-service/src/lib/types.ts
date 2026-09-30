export type {
  PreviewWorkflowController,
  PreviewWorkflowEvent,
  PreviewWorkflowLastError,
  PreviewWorkflowPhase,
  PreviewWorkflowSnapshot,
  PreviewWorkflowUiDiagnostic
} from "@nuriteo/preview-service";

export type {
  ProjectWorkspaceEditorFile,
  ProjectWorkspaceTreeNode,
  SupportedPackageManager,
  TemplateId
} from "@nuriteo/browser-host";

export type DockTab = "terminal" | "diagnostics";

export interface PreviewServiceApi {
  controller: import("@nuriteo/preview-service").PreviewWorkflowController;
  loadTemplate: (id?: import("@nuriteo/browser-host").TemplateId) => import("@nuriteo/preview-service").PreviewWorkflowSnapshot;
  importZipFile: (file: Blob) => Promise<import("@nuriteo/preview-service").PreviewWorkflowSnapshot>;
  importGitHub: (url: string) => Promise<import("@nuriteo/preview-service").PreviewWorkflowSnapshot>;
  exportZip: () => Uint8Array;
  setPackageManagerOverride: (value: import("@nuriteo/browser-host").SupportedPackageManager | null) => void;
  runPreview: () => Promise<import("@nuriteo/preview-service").PreviewWorkflowSnapshot>;
  restartDev: () => Promise<import("@nuriteo/preview-service").PreviewWorkflowSnapshot>;
  reconnectHmr: () => Promise<unknown>;
  runBuild: () => Promise<import("@nuriteo/preview-service").PreviewWorkflowSnapshot>;
  clearPackageCache: () => { freedBytes: number; evicted: number };
  resolveWriterConflict: () => void;
  runRecoveryAction: (kind: string) => Promise<unknown>;
  simulateQuotaPressure: (bytes?: number) => void;
  snapshot: () => import("@nuriteo/preview-service").PreviewWorkflowSnapshot;
  openFile: (path: string) => void;
  editCurrentFile: (data: string) => void;
  saveCurrentFile: () => void;
}

declare global {
  // eslint-disable-next-line no-var
  var __previewService: PreviewServiceApi;
}

export {};
