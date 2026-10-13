export {
  detectPackageScripts
} from "./package-detect.ts";
export type {
  DetectPackageScriptsInput,
  OnboardingDiagnostic,
  OnboardingDiagnosticCode,
  PackageManagerDetectionSource,
  PackageScriptDetection,
  SupportedPackageManager
} from "./package-detect.ts";

export {
  getProjectTemplate,
  listProjectTemplates,
  workflowTemplateForProjectTemplate
} from "./templates.ts";
export type {
  ProjectTemplate,
  TemplateFile,
  TemplateId
} from "./templates.ts";

export {
  exportProjectZip,
  importProjectZip
} from "./zip-adapter.ts";
export type {
  ZipExportInput,
  ZipImportResult,
  ZipProjectFile
} from "./zip-adapter.ts";

export {
  importPublicGitHubRepo,
  parseGitHubRepoUrl
} from "./github-import.ts";
export type {
  GitHubImportOptions,
  GitHubRepoRef
} from "./github-import.ts";

export {
  createProjectHealthCheck
} from "./health-check.ts";
export type {
  ProjectHealthInput,
  ProjectHealthReport
} from "./health-check.ts";

export {
  exportMaterializedProjectZip,
  materializeGitHubUrl,
  materializeTemplate,
  materializeZip
} from "./materialize.ts";
export type {
  MaterializeOptions,
  MaterializedProject
} from "./materialize.ts";
