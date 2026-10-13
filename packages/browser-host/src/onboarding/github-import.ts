import { importProjectZip, type ZipImportResult } from "./zip-adapter.ts";
import type { OnboardingDiagnostic } from "./package-detect.ts";

export interface GitHubRepoRef {
  owner: string;
  repo: string;
  ref: string;
  archiveUrl: string;
}

export interface GitHubImportOptions {
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  defaultRef?: string;
}

export async function importPublicGitHubRepo(
  input: string,
  options: GitHubImportOptions = {}
): Promise<ZipImportResult> {
  let ref: GitHubRepoRef;
  try {
    ref = parseGitHubRepoUrl(input, options.defaultRef || "main");
  } catch (error) {
    return {
      files: [],
      rootPrefix: "",
      diagnostics: [{
        code: "ERR_IMPORT_NETWORK",
        level: "error",
        message: error instanceof Error ? error.message : "Invalid GitHub URL.",
        recoveryHint: "Use a public GitHub repository URL such as https://github.com/owner/repo."
      }]
    };
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!fetchImpl) {
    return {
      files: [],
      rootPrefix: "",
      diagnostics: [{
        code: "ERR_IMPORT_NETWORK",
        level: "error",
        message: "fetch is unavailable in this environment.",
        recoveryHint: "Import from zip or template instead."
      }]
    };
  }

  try {
    const response = await fetchImpl(ref.archiveUrl, {
      headers: {
        Accept: "application/zip,application/octet-stream"
      }
    });
    if (!response.ok) {
      return {
        files: [],
        rootPrefix: "",
        diagnostics: [{
          code: "ERR_IMPORT_NETWORK",
          level: "error",
          message: `GitHub archive download failed with HTTP ${response.status}.`,
          recoveryHint: "Confirm the repository is public and the branch/tag exists."
        }]
      };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return importProjectZip(bytes, options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {});
  } catch (error) {
    const diagnostics: OnboardingDiagnostic[] = [{
      code: "ERR_IMPORT_NETWORK",
      level: "error",
      message: error instanceof Error ? error.message : "GitHub archive download failed.",
      recoveryHint: "Check network access or import a zip instead."
    }];
    return { files: [], rootPrefix: "", diagnostics };
  }
}

export function parseGitHubRepoUrl(input: string, defaultRef = "main"): GitHubRepoRef {
  const trimmed = input.trim().replace(/\.git$/, "");
  let owner = "";
  let repo = "";
  let ref = defaultRef;

  const https = trimmed.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)(?:\/(?:tree|blob)\/([^/#?]+))?/i
  );
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/#?]+)$/i);
  const shorthand = trimmed.match(/^([^/]+)\/([^/#?]+)$/);

  if (https?.[1] && https[2]) {
    owner = https[1];
    repo = https[2];
    if (https[3]) ref = https[3];
  } else if (ssh?.[1] && ssh[2]) {
    owner = ssh[1];
    repo = ssh[2];
  } else if (shorthand?.[1] && shorthand[2]) {
    owner = shorthand[1];
    repo = shorthand[2];
  } else {
    throw new Error("Unsupported GitHub URL. Expected https://github.com/owner/repo.");
  }

  repo = repo.replace(/\/+$/, "");
  return {
    owner,
    repo,
    ref,
    archiveUrl: `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${encodeURIComponent(ref)}`
  };
}
