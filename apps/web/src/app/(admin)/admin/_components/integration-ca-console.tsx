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

import { Badge } from "#src/components/ui/badge.tsx";
import { Button } from "#src/components/ui/button.tsx";
import { CollapsibleContent, CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "#src/components/ui/collapsible.tsx";
import { TextareaField } from "#src/components/ui/field.tsx";
import { createBrowserApiClient } from "#src/lib/api/browser-client.ts";
import { readCsrfCredential } from "#src/lib/api/browser-security.ts";
import { AdminEmptyState, AdminForm, AdminFormActionNote, AdminFormActions, AdminFormFieldSpan, AdminFormSection } from "#src/app/(admin)/admin/_components/admin-form-layout.tsx";
import { AdminCollectionHeading } from "#src/app/(admin)/admin/_components/admin-surface.tsx";

interface IntegrationCaConsoleProps {
  readonly initialCollection?: IntegrationCaCollection | undefined;
  readonly type: IntegrationCaType;
  readonly integrationId: string;
}

export function IntegrationCaConsole({ initialCollection, type, integrationId }: IntegrationCaConsoleProps) {
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
    <section className="col-span-full mt-4 border-t border-muted-border pt-4" aria-label="사설 인증 기관">
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
              <AdminFormSection title="인증서 번들" description="연동 서버를 신뢰하는 데 필요한 PEM 형식의 사설 루트 또는 중간 인증서를 등록합니다.">
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
            <ul className="mt-6 grid list-none gap-2 p-0 [&>li]:[content-visibility:auto] [&>li]:[contain-intrinsic-size:auto_5rem]">
              {items.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>{item.state === "active" ? "활성 인증서" : "검증 대기 후보"}</strong>
                    <span>
                      CA 버전 {item.version} · {new Date(item.earliestExpiry).toLocaleDateString("ko-KR")} 만료
                    </span>
                    <small>{item.fingerprints.join(", ")}</small>
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
      {message ? <p role={message.error ? "alert" : "status"}>{message.text}</p> : null}
    </section>
  );
}

function failure(error: unknown) {
  if (error instanceof ApiError && (error.status === 403 || error.status === 428)) {
    return { error: true, text: "관리자 권한과 최근 재인증이 필요합니다." };
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
