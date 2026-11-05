"use client";

import type { AdminSupportBundlePreview } from "@nuriteo/api-client";

import { useSupportBundleDownload } from "@/app/(admin)/admin/operations/_hooks/use-support-bundle-download.ts";
import { Button } from "@/components/ui/button.tsx";
import {
  CollapsibleContent,
  CollapsibleIndicator,
  CollapsiblePanel,
  CollapsibleRoot,
  CollapsibleTrigger
} from "@/components/ui/collapsible.tsx";

export function SupportBundleDownload({ preview }: { readonly preview: AdminSupportBundlePreview }) {
  const { download, state } = useSupportBundleDownload(preview);

  return (
    <div>
      <p className="m-0 border-t border-muted-border px-5 py-4 text-sm text-foreground">
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
      <p className="m-0 border-t border-muted-border px-5 py-4 text-xs text-muted-foreground">
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

function formatBytes(value: number): string {
  return `${new Intl.NumberFormat("ko-KR").format(value / 1024)} KiB`;
}
