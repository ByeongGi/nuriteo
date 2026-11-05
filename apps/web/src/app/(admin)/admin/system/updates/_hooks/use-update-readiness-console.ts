"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { getAdminUpdateHistory } from "@/app/(admin)/admin/system/updates/_utils/update-model.ts";
import { createBrowserApiClient } from "@/lib/api/browser-client.ts";
import { readCsrfCredential } from "@/lib/api/browser-security.ts";
import { useExclusiveMutation } from "@/lib/use-exclusive-mutation.ts";
import { ApiError } from "@/services/http/api.ts";

import type { AdminUpdateHistory, AdminUpdateReadiness } from "@/app/(admin)/admin/system/updates/_utils/update-model.ts";

export function useUpdateReadinessConsole(readiness: AdminUpdateReadiness) {
  const router = useRouter();
  const mutation = useExclusiveMutation();
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  async function approve() {
    await mutation.run(async () => {
      setError(undefined);
      setNotice(undefined);
      try {
        await createBrowserApiClient().post(
          "/admin/updates/approval",
          { targetRelease: readiness.targetRelease, acknowledged: true },
          { headers: { "x-csrf-token": readCsrfCredential() } }
        );
        setAcknowledged(false);
        setNotice("업데이트 승인을 기록했습니다. 업데이트는 시작하지 않았습니다.");
        router.refresh();
      } catch (cause) {
        setError(approvalError(cause));
      }
    });
  }

  return { acknowledged, approve, error, mutation, notice, setAcknowledged };
}

export function useUpdateApprovalHistory(history: AdminUpdateHistory) {
  const [pages, setPages] = useState<readonly AdminUpdateHistory[]>([history]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState<string>();
  const page = pages[pageIndex] ?? history;

  async function nextPage() {
    if (pageIndex < pages.length - 1) {
      setPageIndex((current) => current + 1);
      return;
    }
    if (page.nextCursor === null || loading) return;
    setLoading(true);
    setPageError(undefined);
    try {
      const next = await getAdminUpdateHistory(createBrowserApiClient(), { cursor: page.nextCursor, limit: 25 });
      setPages((current) => [...current, next]);
      setPageIndex((current) => current + 1);
    } catch {
      setPageError("다음 승인 이력을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }

  function previousPage() {
    setPageIndex((current) => Math.max(0, current - 1));
  }

  return { loading, nextPage, page, pageError, pageIndex, pages, previousPage };
}

function approvalError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "REAUTHENTICATION_REQUIRED") {
      return "보안을 위해 다시 로그인한 뒤 업데이트 승인을 다시 시도하세요.";
    }
    if (error.status === 403) {
      return "업데이트를 승인할 관리자 권한이 없습니다.";
    }
    if (error.status === 409) {
      return "준비 상태가 변경되어 승인을 기록하지 않았습니다. 최신 차단 요인을 검토하세요.";
    }
    if (error.code === "COMMIT_OUTCOME_UNKNOWN") {
      return "승인 결과를 확인할 수 없습니다. 기록을 새로 불러온 뒤 다시 시도하세요.";
    }
  }
  return "승인을 기록하지 못했습니다. 업데이트는 시작되지 않았습니다.";
}
