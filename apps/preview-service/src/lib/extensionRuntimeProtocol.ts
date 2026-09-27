import type { LspDiagnostic } from "./lspProtocol.ts";

export interface ExtensionDocument {
  uri: string;
  languageId: string;
  text: string;
  version: number;
}

export interface ExtensionActivationResult {
  extensionId: string;
  contributions: {
    commands?: string[];
    languages?: string[];
  };
}

export interface ExtensionCommandResult {
  message?: string;
  edit?: { uri: string; text: string };
}

export interface ExtensionDiagnosticsResult {
  diagnostics: LspDiagnostic[];
}
