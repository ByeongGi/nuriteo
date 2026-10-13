"use client";

import { useState } from "react";

import type { AdminSupportBundlePreview } from "@nuriteo/api-client";

export function SupportBundleDownload({ preview }: { readonly preview: AdminSupportBundlePreview }) {
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

  return (
    <div>
      <p className="admin-operations-card__summary">
        Review the allowlist below, then create a local JSON file. Nothing is uploaded automatically.
      </p>
      <details>
        <summary>Included and excluded data</summary>
        <h3>Included</h3>
        <ul>{preview.includes.map((item) => <li key={item}>{item}</li>)}</ul>
        <h3>Always excluded</h3>
        <ul>{preview.excludes.map((item) => <li key={item}>{item}</li>)}</ul>
      </details>
      <p className="admin-operations-card__note">
        Maximum download size: {formatBytes(preview.maximumBytes)}. Project files, credentials,
        request bodies, and database rows are never included.
      </p>
      <button className="button button--sm" type="button" disabled={state === "working"} onClick={() => void download()}>
        {state === "working" ? "Preparing…" : "Download support bundle"}
      </button>
      {state === "failed" ? (
        <p role="alert">The support bundle could not be created. Retry and use the request reference if the problem continues.</p>
      ) : null}
    </div>
  );
}

function isSupportBundle(value: unknown, format: string): value is { schemaVersion: 1; format: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (value as Record<string, unknown>).schemaVersion === 1 &&
    (value as Record<string, unknown>).format === format;
}

function formatBytes(value: number): string {
  return `${new Intl.NumberFormat("en").format(value / 1024)} KiB`;
}
