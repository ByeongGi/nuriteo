"use client";

import { useState } from "react";

import type { AdminSupportBundlePreview } from "@nuriteo/api-client";

export function useSupportBundleDownload(preview: AdminSupportBundlePreview) {
  const [state, setState] = useState<"idle" | "working" | "failed">("idle");

  async function download(): Promise<void> {
    if (state === "working") return;
    setState("working");
    try {
      const response = await fetch("/api/v1/admin/support-bundle", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" }
      });
      const contentLength = response.headers.get("content-length");
      if (!response.ok || (contentLength !== null && Number(contentLength) > preview.maximumBytes)) {
        throw new Error("support bundle rejected");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > preview.maximumBytes) throw new Error("support bundle too large");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed: unknown = JSON.parse(text);
      if (!isSupportBundle(parsed, preview.format)) throw new Error("support bundle malformed");
      const blob = new Blob([bytes], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `nuriteo-support-${new Date().toISOString().replaceAll(":", "-")}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setState("idle");
    } catch {
      setState("failed");
    }
  }

  return { download, state };
}

function isSupportBundle(value: unknown, format: string): value is { schemaVersion: 1; format: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (value as Record<string, unknown>).schemaVersion === 1 &&
    (value as Record<string, unknown>).format === format;
}
