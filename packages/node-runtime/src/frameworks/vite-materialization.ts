import type { CliModuleGraphIssue } from "../package-managers/cli-module-graph.ts";

export interface ViteDependencyMaterializationPlan {
  summary: ViteDependencyMaterializationSummary;
  missing: ViteDependencyMaterializationItem[];
  optional: ViteDependencyMaterializationOptionalItem[];
  satisfied: string[];
}

export interface ViteDependencyMaterializationSummary {
  missingByKind: Record<ViteDependencyMaterializationKind, number>;
  missingCount: number;
  optionalCount: number;
  satisfiedCount: number;
}

export interface ViteDependencyMaterializationItem {
  artifactNames: string[];
  kind: ViteDependencyMaterializationKind;
  name: string;
  nextAction: string;
  specifiers: string[];
  wasm?: ViteDependencyMaterializationWasmReplacement;
}

export type ViteDependencyMaterializationKind = "package-artifact" | "wasm-adapter-candidate" | "native-hold";

export interface ViteDependencyMaterializationWasmReplacement {
  adapterName?: string;
  fallbackPolicy: "deny-native" | "prefer-wasm" | "allow-js";
  status?: string;
  wasmPackage: string;
}

export interface ViteDependencyMaterializationOptionalItem {
  kind: ViteDependencyMaterializationOptionalKind;
  nextAction: string;
  specifier: string;
}

export type ViteDependencyMaterializationOptionalKind = Extract<
  CliModuleGraphIssue["kind"],
  "optional-native-probe" | "optional-cache-probe" | "optional-dependency-probe"
>;

export interface ViteRuntimeCapabilityStatus {
  capability: ViteRuntimeReadinessCapability;
  evidence: string;
  nextAction?: string;
  status: "ready" | "blocked";
}

export type ViteRuntimeReadinessCapability =
  | ViteRuntimeCapability
  | "esm-cli-entrypoint"
  | "minimal-vite-cli-module-graph"
  | "mounted-vite-artifact-input"
  | "cli-registration-hooks"
  | "cli-backed-dev-build-workflow";

export type ViteRuntimeCapability =
  | "actual-vite-cli-module-execution"
  | "real-vite-http-module-transform"
  | "real-vite-hmr-protocol"
  | "framework-plugin-module-execution";
