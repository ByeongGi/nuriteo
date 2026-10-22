"use client";

import { useState } from "react";

import type { AdminSupportBundlePreview } from "@nuriteo/api-client";

import { Button } from "#src/components/ui/button.tsx";
import {
  CollapsibleContent,
  CollapsibleIndicator,
  CollapsiblePanel,
  CollapsibleRoot,
  CollapsibleTrigger
} from "#src/components/ui/collapsible.tsx";

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
        아래 포함 항목을 확인한 뒤 로컬 JSON 파일을 만드세요. 어떤 정보도 자동으로 업로드되지 않습니다.
      </p>
      <CollapsibleRoot>
        <CollapsibleTrigger>
          포함 및 제외 데이터
          <CollapsibleIndicator>⌄</CollapsibleIndicator>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <CollapsibleContent>
            <h3>포함 항목</h3>
            <ul>{preview.includes.map((item) => <li key={item}>{item}</li>)}</ul>
            <h3>항상 제외되는 항목</h3>
            <ul>{preview.excludes.map((item) => <li key={item}>{item}</li>)}</ul>
          </CollapsibleContent>
        </CollapsiblePanel>
      </CollapsibleRoot>
      <p className="admin-operations-card__note">
        최대 다운로드 크기는 {formatBytes(preview.maximumBytes)}입니다. 프로젝트 파일, 자격 증명,
        요청 본문과 데이터베이스 행은 포함되지 않습니다.
      </p>
      <Button size="sm" type="button" disabled={state === "working"} onClick={() => void download()}>
        {state === "working" ? "준비 중…" : "지원 번들 다운로드"}
      </Button>
      {state === "failed" ? (
        <p role="alert">지원 번들을 만들지 못했습니다. 다시 시도하고 문제가 계속되면 요청 참조값을 알려 주세요.</p>
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
  return `${new Intl.NumberFormat("ko-KR").format(value / 1024)} KiB`;
}
