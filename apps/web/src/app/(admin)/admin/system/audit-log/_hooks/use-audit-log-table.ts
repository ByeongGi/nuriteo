"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";

import { parseAuditEventCollection } from "@/app/(admin)/admin/system/audit-log/_utils/audit-log-model.ts";

import type { AuditEventPage } from "@/app/(admin)/admin/system/audit-log/_utils/audit-log-model.ts";

export const AUDIT_PAGE_SIZE = 25;

export function useAuditLogTable(initialPage: AuditEventPage) {
  const [pageIndex, setPageIndex] = useState(0);
  const query = useInfiniteQuery({
    queryKey: ["admin", "audit-events", AUDIT_PAGE_SIZE, initialPage.items[0]?.id ?? "empty"],
    queryFn: ({ pageParam }) => fetchAuditPage(pageParam),
    initialPageParam: null as string | null,
    initialData: { pages: [initialPage], pageParams: [null] },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000
  });
  const pages = query.data.pages;
  const page = pages[pageIndex] ?? initialPage;
  const hasPrevious = pageIndex > 0;
  const hasNext = pageIndex < pages.length - 1 || page.nextCursor !== null;

  async function nextPage() {
    if (pageIndex < pages.length - 1) {
      setPageIndex((current) => current + 1);
      return;
    }
    if (page.nextCursor === null || query.isFetchingNextPage) return;
    const result = await query.fetchNextPage();
    if (result.data !== undefined && result.data.pages.length > pages.length) setPageIndex((current) => current + 1);
  }

  function previousPage() {
    setPageIndex((current) => Math.max(0, current - 1));
  }

  return { hasNext, hasPrevious, nextPage, page, pageIndex, previousPage, query };
}

async function fetchAuditPage(cursor: string | null): Promise<AuditEventPage> {
  const query = new URLSearchParams({ limit: String(AUDIT_PAGE_SIZE) });
  if (cursor !== null) query.set("cursor", cursor);
  const response = await fetch(`/api/v1/admin/audit-events?${query.toString()}`, { credentials: "same-origin" });
  if (!response.ok) throw new Error("audit-page-unavailable");
  return parseAuditEventCollection(await response.json());
}
