"use client";

import Link from "next/link";

import { useCleanupPreview } from "@/app/(admin)/admin/operations/storage-cleanup/_hooks/use-cleanup-preview.ts";
import { AdminPageHeader } from "@/app/(admin)/admin/_components/admin-page-header.tsx";
import { AdminNote, AdminPage, AdminSection, AdminSectionHeading } from "@/app/(admin)/admin/_components/admin-surface.tsx";
import { Button } from "@/components/ui/button.tsx";

import type { AdminPolicyCleanupPreview } from "@nuriteo/api-client";

export function StorageCleanupPreview({ initial }: { readonly initial: AdminPolicyCleanupPreview }) {
  const { failure, mutation, preview, refresh } = useCleanupPreview(initial);

  return (
    <AdminPage id="main-content" contentWidth="narrow">
      <Link className="inline-flex w-fit items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground" href="/admin/operations"><span aria-hidden="true">←</span>운영 현황</Link>
      <AdminPageHeader category="운영" title="스토리지 정리 점검" description="삭제를 실행하지 않고 현재 정책에 따라 정리 가능한 오브젝트와 예상 회수량만 확인합니다." />
      <AdminSection aria-labelledby="cleanup-preview-title">
        <AdminSectionHeading><div><p className="m-0 mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-accent-foreground">읽기 전용 점검</p><h2 id="cleanup-preview-title">정리 예상 결과</h2></div><Button type="button" size="sm" onClick={refresh} disabled={mutation.isPending}>{mutation.isPending ? "새로 고치는 중…" : "다시 점검"}</Button></AdminSectionHeading>
        <dl className="m-0 grid grid-cols-2 border-t border-muted-border max-[37.5rem]:grid-cols-1 [&>div]:border-b [&>div]:border-r [&>div]:border-muted-border [&>div]:px-5 [&>div]:py-4 [&>div:nth-child(2n)]:border-r-0 max-[37.5rem]:[&>div]:border-r-0 [&_dd]:mt-1 [&_dd]:text-lg [&_dd]:font-semibold [&_dt]:text-xs [&_dt]:text-muted-foreground">
          <Metric label="가비지 컬렉션" value={preview.gcEnabled ? "켜짐" : "꺼짐"} />
          <Metric label="유예 기간" value={formatDuration(preview.gracePeriodSeconds)} />
          <Metric label="정리 대상" value={`${preview.eligibleCandidates.toLocaleString("ko-KR")}개`} />
          <Metric label="예상 회수량" value={formatBytes(preview.expectedReclaimBytes)} />
        </dl>
        <AdminNote>최대 {preview.batchLimit.toLocaleString("ko-KR")}개 후보를 확인했습니다. 이 화면에서는 오브젝트를 삭제하지 않습니다.</AdminNote>
        {failure ? <p className="m-0 border-t border-danger px-5 py-3 text-sm text-danger" role="alert">정리 미리보기를 새로 고치지 못했습니다.</p> : null}
      </AdminSection>
    </AdminPage>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function formatDuration(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}일`;
  if (seconds % 3600 === 0) return `${seconds / 3600}시간`;
  return `${seconds.toLocaleString("ko-KR")}초`;
}

function formatBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes)) return `${value}바이트`;
  return new Intl.NumberFormat("ko-KR", { style: "unit", unit: "megabyte", maximumFractionDigits: 1 }).format(bytes / 1_048_576);
}
