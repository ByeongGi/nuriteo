"use client";

import type { IntegrationCaCollection, IntegrationCaType } from "@nuriteo/api-client";
import { tv } from "tailwind-variants";

import { AdminEmptyState, AdminForm, AdminFormActionNote, AdminFormActions, AdminFormFieldSpan, AdminFormSection } from "@/app/(admin)/admin/_components/admin-form-layout.tsx";
import { AdminCollectionHeading } from "@/app/(admin)/admin/_components/admin-surface.tsx";
import { useIntegrationCaConsole } from "@/app/(admin)/admin/_hooks/use-integration-ca-console.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { CollapsibleContent, CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "@/components/ui/collapsible.tsx";
import { TextareaField } from "@/components/ui/field.tsx";

interface IntegrationCaConsoleProps {
  readonly appearance?: "detail" | "embedded" | "standalone";
  readonly initialCollection?: IntegrationCaCollection | undefined;
  readonly type: IntegrationCaType;
  readonly integrationId: string;
}

const integrationCaStyles = tv({
  slots: {
    root: "col-span-full min-w-0",
    list: "mt-4 grid list-none gap-2 p-0",
    item: "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-md border border-muted-border bg-subtle px-4 py-3 [content-visibility:auto] [contain-intrinsic-size:auto_5rem] max-[42rem]:grid-cols-1 max-[42rem]:items-stretch max-[42rem]:[&_[data-slot=button]]:w-full",
    itemCopy: "grid min-w-0 gap-1",
    itemHeading: "flex flex-wrap items-center gap-2",
    itemMeta: "text-xs text-muted-foreground",
    fingerprint: "m-0 font-mono text-[var(--n-font-size-2xs)] leading-5 text-subtle-foreground [overflow-wrap:anywhere]",
    message: "mt-3 mb-0 rounded-md border border-muted-border bg-subtle px-3 py-2 text-sm"
  },
  variants: {
    appearance: {
      detail: { root: "" },
      embedded: { root: "mt-4 border-t border-muted-border pt-4" },
      standalone: { root: "rounded-lg border border-muted-border bg-surface p-5 max-[37.5rem]:p-4" }
    }
  },
  defaultVariants: { appearance: "embedded" }
});

export function IntegrationCaConsole({ appearance = "embedded", initialCollection, type, integrationId }: IntegrationCaConsoleProps) {
  const styles = integrationCaStyles({ appearance });
  const { activate, items, load, message, pending, stage } = useIntegrationCaConsole(initialCollection, type, integrationId);

  return (
    <section className={styles.root()} aria-label="사설 인증 기관">
      {items === undefined ? (
        <Button onClick={() => void load()} disabled={pending}>
          CA 신뢰 기록 불러오기
        </Button>
      ) : (
        <>
          <AdminCollectionHeading>
            <h3>사설 인증 기관</h3>
            <Badge>등록 {items.length}개</Badge>
          </AdminCollectionHeading>
          <CollapsibleRoot className="mt-4">
            <CollapsibleTrigger>새 CA 후보 등록</CollapsibleTrigger>
            <CollapsiblePanel><CollapsibleContent><AdminForm onSubmit={(event) => void stage(event)} aria-busy={pending}>
              <AdminFormSection orientation="stacked" title="인증서 번들" description="연동 서버를 신뢰하는 데 필요한 PEM 형식의 사설 루트 또는 중간 인증서를 등록합니다.">
                <AdminFormFieldSpan>
                  <TextareaField label="PEM CA 번들" name="pem" required maxLength={1_048_576} rows={5} spellCheck={false} disabled={pending} />
                </AdminFormFieldSpan>
              </AdminFormSection>
              <AdminFormActions>
                <AdminFormActionNote>최대 1MiB, 유효한 CA 인증서 64개까지 등록할 수 있습니다. 엔드포인트는 연동 설정의 값을 그대로 사용합니다.</AdminFormActionNote>
                <Button disabled={pending}>CA 후보 저장</Button>
              </AdminFormActions>
            </AdminForm></CollapsibleContent></CollapsiblePanel>
          </CollapsibleRoot>
          {(function () {
    if (items.length === 0) {
        return ((
            <AdminEmptyState title="사용자 CA가 없습니다">현재 시스템 신뢰 저장소만 사용하고 있습니다.</AdminEmptyState>
          ));
    }
    return ((
            <ul className={styles.list()}>
              {items.map((item) => (
                <li className={styles.item()} key={item.id}>
                  <div className={styles.itemCopy()}>
                    <div className={styles.itemHeading()}>
                      <strong>{(function () {
    if (item.state === "active") {
        return ("활성 인증서");
    }
    return ("검증 대기 후보");
})()}</strong>
                      <Badge size="sm" tone={(function () {
    if (item.state === "active") {
        return ("success");
    }
    return ("warning");
})()} variant="status">
                        {(function () {
    if (item.state === "active") {
        return ("사용 중");
    }
    return ("검증 필요");
})()}
                      </Badge>
                    </div>
                    <span className={styles.itemMeta()}>
                      CA 버전 {item.version} · {new Date(item.earliestExpiry).toLocaleDateString("ko-KR")} 만료
                    </span>
                    <p className={styles.fingerprint()}>SHA-256 · {item.fingerprints.join(" · ")}</p>
                  </div>
                  {(function () {
    if (item.state === "candidate") {
        return ((
                    <Button variant="primary" disabled={pending} onClick={() => void activate(item)}>
                      사전 점검 후 활성화
                    </Button>
                  ));
    }
    return (null);
})()}
                </li>
              ))}
            </ul>
          ));
})()}
        </>
      )}
      {message ? <p className={styles.message()} role={(function () {
    if (message.error) {
        return ("alert");
    }
    return ("status");
})()}>{message.text}</p> : null}
    </section>
  );
}


