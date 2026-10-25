"use client";

import {
  ApiError,
  activateIntegrationCa,
  listIntegrationCas,
  stageIntegrationCa,
} from "@nuriteo/api-client";
import type { IntegrationCaBundle, IntegrationCaCollection, IntegrationCaType } from "@nuriteo/api-client";
import { useState } from "react";
import type { FormEvent } from "react";
import { tv } from "tailwind-variants";

import { Badge } from "#src/components/ui/badge.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { CollapsibleContent, CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "#src/components/ui/collapsible.tsx";
import { TextareaField } from "#src/components/ui/field.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { AdminEmptyState, AdminForm, AdminFormActionNote, AdminFormActions, AdminFormFieldSpan, AdminFormSection } from "#src/app/(admin)/admin/_components/admin-form-layout.tsx";
import { AdminCollectionHeading } from "#src/app/(admin)/admin/_components/admin-surface.tsx";

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
  const [items, setItems] = useState<readonly IntegrationCaBundle[] | undefined>(initialCollection?.items);
  const [version, setVersion] = useState(initialCollection?.version ?? 0);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ readonly error: boolean; readonly text: string }>();

  async function load() {
    setPending(true);
    setMessage(undefined);
    try {
      const result = await listIntegrationCas(createBrowserApiClient(), type, integrationId);
      setItems(result.data.items);
      setVersion(result.data.version);
    } catch (error) {
      setMessage(failure(error));
    } finally {
      setPending(false);
    }
  }

  async function stage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const pem = String(new FormData(form).get("pem") ?? "");
    form.reset();
    setPending(true);
    setMessage(undefined);
    try {
      const result = await stageIntegrationCa(createBrowserApiClient(), type, integrationId, version, pem, {
        csrfToken: readCsrfCredential(),
        idempotencyKey: crypto.randomUUID(),
      });
      setItems((current) => [result.data, ...(current ?? []).filter((item) => item.state !== "candidate")]);
      setVersion(result.data.version);
      setMessage({ error: false, text: "CA 후보를 저장했습니다. 인증서 본문은 이 브라우저에서 제거했습니다." });
    } catch (error) {
      setMessage(failure(error));
    } finally {
      setPending(false);
    }
  }

  async function activate(candidate: IntegrationCaBundle) {
    setPending(true);
    setMessage(undefined);
    try {
      await activateIntegrationCa(createBrowserApiClient(), type, integrationId, candidate.id, candidate.version, {
        csrfToken: readCsrfCredential(),
        idempotencyKey: crypto.randomUUID(),
      });
      await load();
      setMessage({ error: false, text: "실제 연동 사전 점검을 통과해 CA를 활성화했습니다." });
    } catch (error) {
      setMessage(failure(error));
      setPending(false);
    }
  }

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
          {items.length === 0 ? (
            <AdminEmptyState title="사용자 CA가 없습니다">현재 시스템 신뢰 저장소만 사용하고 있습니다.</AdminEmptyState>
          ) : (
            <ul className={styles.list()}>
              {items.map((item) => (
                <li className={styles.item()} key={item.id}>
                  <div className={styles.itemCopy()}>
                    <div className={styles.itemHeading()}>
                      <strong>{item.state === "active" ? "활성 인증서" : "검증 대기 후보"}</strong>
                      <Badge size="sm" tone={item.state === "active" ? "success" : "warning"} variant="status">
                        {item.state === "active" ? "사용 중" : "검증 필요"}
                      </Badge>
                    </div>
                    <span className={styles.itemMeta()}>
                      CA 버전 {item.version} · {new Date(item.earliestExpiry).toLocaleDateString("ko-KR")} 만료
                    </span>
                    <p className={styles.fingerprint()}>SHA-256 · {item.fingerprints.join(" · ")}</p>
                  </div>
                  {item.state === "candidate" ? (
                    <Button variant="primary" disabled={pending} onClick={() => void activate(item)}>
                      사전 점검 후 활성화
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {message ? <p className={styles.message()} role={message.error ? "alert" : "status"}>{message.text}</p> : null}
    </section>
  );
}

function failure(error: unknown) {
  if (error instanceof ApiError && error.code === "REAUTHENTICATION_REQUIRED") {
    return { error: true, text: "보안을 위해 다시 로그인한 뒤 CA 변경을 다시 시도하세요." };
  }
  if (error instanceof ApiError && error.status === 403) {
    return { error: true, text: "이 CA 변경을 수행할 관리자 권한이 없습니다." };
  }
  if (error instanceof ApiError && error.status === 428) {
    return { error: true, text: "최신 CA 상태를 다시 불러온 뒤 변경을 다시 시도하세요." };
  }
  if (error instanceof ApiError && error.status === 412) {
    return { error: true, text: "다른 곳에서 CA 상태가 변경되었습니다. 신뢰 기록을 새로 불러온 뒤 다시 시도하세요." };
  }
  if (error instanceof ApiError && error.status === 422) {
    return { error: true, text: "CA 번들 또는 실제 연동 사전 점검이 거부되었습니다." };
  }
  if (error instanceof ApiError && error.status === 404) {
    return { error: true, text: "사설 CA 신뢰를 추가하기 전에 연동을 먼저 구성하세요." };
  }
  return { error: true, text: "CA 신뢰 설정을 안전하게 변경하지 못했습니다." };
}
