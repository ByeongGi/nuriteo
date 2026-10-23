"use client";

import Link from "next/link";
import { tv } from "tailwind-variants";

import { Button } from "#src/components/ui/button.tsx";
import { SystemState } from "#src/app/_components/system-state.tsx";

interface ErrorViewProps {
  homeHref?: string | undefined;
  homeLabel?: string | undefined;
  onRetry: () => void;
  reference?: string | undefined;
}

export function ErrorView({ homeHref = "/", homeLabel = "홈으로 돌아가기", onRetry, reference }: ErrorViewProps) {
  const styles = errorViewStyles();
  return (
    <SystemState
      actions={(
        <>
          <Button className={styles.action()} variant="primary" onClick={onRetry}>
            다시 시도
          </Button>
          <Button className={styles.action()} render={<Link href={homeHref} />}>
            {homeLabel}
          </Button>
        </>
      )}
      description="작업 내용은 변경되지 않았습니다. 페이지를 다시 시도하거나 홈으로 돌아가세요."
      kind="service-unavailable"
      reference={reference}
      title="이 페이지를 안전하게 불러오지 못했습니다"
    />
  );
}

const errorViewStyles = tv({ slots: { action: "max-[24rem]:w-full" } });
