"use client";

import { useState } from "react";

import { integrationCaPemSchema } from "@/app/(admin)/admin/_schema/integration-ca.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { activateIntegrationCa, listIntegrationCas, stageIntegrationCa } from "@/services/integration-ca/api.ts";
import { ApiError } from "@/services/http/api.ts";

import type { FormEvent } from "react";
import type { IntegrationCaBundle, IntegrationCaCollection, IntegrationCaType } from "@nuriteo/api-client";

export function useIntegrationCaConsole(initialCollection: IntegrationCaCollection | undefined, type: IntegrationCaType, integrationId: string) {
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
    const parsed = integrationCaPemSchema.safeParse({ pem: String(new FormData(form).get("pem") ?? "") });
    if (!parsed.success) {
      setMessage({ error: true, text: parsed.error.issues[0]?.message ?? "CA 번들 또는 실제 연동 사전 점검이 거부되었습니다." });
      return;
    }
    const pem = parsed.data.pem;
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

  return { activate, items, load, message, pending, stage };
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
