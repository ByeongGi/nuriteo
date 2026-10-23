import Link from "next/link";
import type { ReactNode } from "react";
import { tv } from "tailwind-variants";

import { ProductEntryShell } from "#src/app/_components/product-entry-shell.tsx";
import { Button } from "#src/components/ui/button.tsx";

type SystemStateKind = "access-denied" | "not-found" | "service-unavailable" | "stale";

interface SystemStateProps {
  readonly actions?: ReactNode;
  readonly description: string;
  readonly kind: SystemStateKind;
  readonly reference?: string | undefined;
  readonly title: string;
}

const stateStyles = tv({
  slots: {
    body: "mt-6 grid gap-4",
    reference:
      "m-0 overflow-wrap-anywhere rounded-md border border-muted-border bg-subtle px-3 py-2 font-mono text-xs text-muted-foreground",
    actions: "flex flex-wrap items-center gap-3 max-[24rem]:grid max-[24rem]:grid-cols-1",
    action: "max-[24rem]:w-full"
  }
});

const stateCopy: Record<SystemStateKind, { readonly eyebrow: string }> = {
  "access-denied": { eyebrow: "접근 권한이 필요합니다" },
  "not-found": { eyebrow: "페이지를 찾을 수 없습니다" },
  "service-unavailable": { eyebrow: "연결 확인이 필요합니다" },
  stale: { eyebrow: "최신 상태 확인이 필요합니다" }
};

export function SystemState({ actions, description, kind, reference, title }: SystemStateProps) {
  const styles = stateStyles();
  return (
    <ProductEntryShell
      compact
      description={description}
      eyebrow={stateCopy[kind].eyebrow}
      title={title}
      titleId={`${kind}-title`}
    >
      <div className={styles.body()} role={kind === "service-unavailable" ? "alert" : undefined}>
        {reference ? <p className={styles.reference()}>요청 참조: {reference}</p> : null}
        {actions ? <div className={styles.actions()}>{actions}</div> : null}
      </div>
    </ProductEntryShell>
  );
}

export function AccessDeniedState({ backHref = "/dashboard" }: { readonly backHref?: string }) {
  return (
    <SystemState
      actions={<Button className={stateStyles().action()} render={<Link href={backHref} />}>돌아가기</Button>}
      description="이 화면을 볼 수 있는 역할이 없습니다. 권한이 필요하다면 워크스페이스 관리자에게 문의하세요."
      kind="access-denied"
      title="이 페이지에 접근할 수 없습니다"
    />
  );
}

export function NotFoundState({ homeHref = "/" }: { readonly homeHref?: string }) {
  return (
    <SystemState
      actions={<Button className={stateStyles().action()} render={<Link href={homeHref} />}>홈으로 돌아가기</Button>}
      description="주소를 다시 확인하거나 홈에서 원하는 화면으로 이동하세요."
      kind="not-found"
      title="이 주소에는 페이지가 없습니다"
    />
  );
}

export function ServiceUnavailableState({
  description,
  reference,
  retryHref,
  title
}: {
  readonly description: string;
  readonly reference?: string | undefined;
  readonly retryHref: string;
  readonly title: string;
}) {
  return (
    <SystemState
      actions={<Button className={stateStyles().action()} variant="primary" render={<Link href={retryHref} />}>다시 시도</Button>}
      description={description}
      kind="service-unavailable"
      reference={reference}
      title={title}
    />
  );
}

export function StaleState({
  description = "다른 곳에서 정보가 변경되었습니다. 최신 상태를 불러온 뒤 다시 확인하세요.",
  refreshHref
}: {
  readonly description?: string;
  readonly refreshHref: string;
}) {
  return (
    <SystemState
      actions={<Button className={stateStyles().action()} variant="primary" render={<Link href={refreshHref} />}>최신 상태 불러오기</Button>}
      description={description}
      kind="stale"
      title="화면의 정보가 오래되었습니다"
    />
  );
}

export type { SystemStateKind, SystemStateProps };
