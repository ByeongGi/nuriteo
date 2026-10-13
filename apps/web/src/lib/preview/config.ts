import "server-only";

import fs from "node:fs";

import { resolvePreviewOriginConfiguration } from "../../runtime/preview-origin-contract.ts";
import type { PreviewOriginConfiguration } from "../../runtime/preview-origin-contract.ts";
import { validPreviewSigningKey } from "./signed-binding.ts";

export function previewOriginConfiguration(): PreviewOriginConfiguration {
  const configuration = resolvePreviewOriginConfiguration(process.env);
  if (configuration.status === "enabled" && !validPreviewSigningKey(previewSigningKey())) {
    return { status: "disabled", code: "PREVIEW_CONFIGURATION_INVALID", message: "Preview signing configuration is invalid." };
  }
  return configuration;
}

export function previewSigningKey(): string | undefined {
  const file = process.env.NURITEO_PREVIEW_SIGNING_KEY_FILE;
  if (!file || !file.startsWith("/") || file.length > 512) return undefined;
  try {
    const value = fs.readFileSync(file, { encoding: "utf8" }).trim();
    return validPreviewSigningKey(value) ? value : undefined;
  } catch { return undefined; }
}
