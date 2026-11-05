"use client";

import type { PublicPublishedExample } from "@nuriteo/api-client";

import { usePublishedExamplePreview } from "@/app/(public)/examples/_hooks/use-published-example-preview.ts";
import { examplesStyles } from "@/app/(public)/examples/_components/examples.styles.ts";
import { Button } from "@/components/ui/button.tsx";

import type { PreviewOriginConfiguration } from "@/runtime/preview-origin-contract.ts";

interface PublishedExamplePreviewProps {
  readonly assetRevision?: string;
  readonly example: PublicPublishedExample;
  readonly previewConfiguration: PreviewOriginConfiguration;
}

export function PublishedExamplePreview({
  assetRevision,
  example,
  previewConfiguration
}: PublishedExamplePreviewProps) {
  const styles = examplesStyles();
  const {
    attachPreviewFrame,
    disabled,
    error,
    previewUrl,
    startPreview,
    status,
    stopPreview
  } = usePublishedExamplePreview({ assetRevision, example, previewConfiguration });

  return (
    <section className={styles.preview()} aria-labelledby="published-preview-title">
      <div className={styles.previewHeader()}>
        <div>
          <h3 id="published-preview-title" className={styles.previewTitle()}>
            격리된 미리보기
          </h3>
          <p className={styles.previewDescription()}>
            이 고정 공개 버전을 별도 출처의 임시 브라우저 런타임에서 실행합니다. 계정 쿠키, 인증, CSRF, 환경값과 스토리지 자격 증명은 전송하지 않습니다.
          </p>
        </div>
        {status === "running" || status === "loading" ? (
          <Button type="button" variant="secondary" onClick={() => void stopPreview()}>
            {(function () {
    if (status === "loading") {
        return ("미리보기 취소");
    }
    return ("미리보기 종료");
})()}
          </Button>
        ) : (
          <Button type="button" disabled={disabled || status === "stopping"} onClick={() => void startPreview()}>
            {(function () {
    if (status === "stopping") {
        return ("종료하는 중…");
    }
    return ("격리 미리보기 실행");
})()}
          </Button>
        )}
      </div>

      {previewConfiguration.status === "disabled" ? (
        <p className={styles.previewNotice()} role="status">
          {previewConfiguration.message} 동일 출처 미리보기는 비활성화되어 있습니다.
        </p>
      ) : null}
      {status === "loading" ? (
        <p className={styles.previewNotice()} role="status">
          고정 번들을 검증하고 격리된 런타임을 시작하는 중…
        </p>
      ) : null}
      {error !== undefined ? (
        <p className={styles.previewError()} role="alert">
          {error}
        </p>
      ) : null}
      {previewUrl !== undefined ? (
        <div
          className={styles.previewFrame()}
          data-public-preview-url={previewUrl}
        >
          <iframe
            ref={attachPreviewFrame}
            title={`${example.name} public Preview`}
            className={styles.previewIframe()}
            src={previewUrl}
            sandbox="allow-scripts allow-same-origin"
            allow="cross-origin-isolated"
            referrerPolicy="no-referrer"
          />
        </div>
      ) : null}
    </section>
  );
}
