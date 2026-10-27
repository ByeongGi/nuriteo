import type { ApiClient } from "@nuriteo/api-client";

export interface AdminUpdateCompatibility {
  readonly releaseLineage: string;
  readonly sourceMigration: number;
  readonly configurationRegistryVersion: number;
  readonly schemaPolicy: string;
  readonly objectPolicy: string;
  readonly imagePolicy: string;
  readonly failurePolicy: string;
}

export interface AdminUpdatePreflight {
  readonly state: "passed" | "blocked";
  readonly schemaState: string | null;
  readonly currentMigration: number | null;
  readonly targetMigration: number | null;
  readonly blockerCode: string | null;
}

export interface AdminUpdateBlocker {
  readonly code: string;
  readonly summary: string;
  readonly operatorAction: string;
}

export interface AdminUpdateReadiness {
  readonly generatedAt: string;
  readonly currentRelease: string;
  readonly targetRelease: string;
  readonly state: "ready" | "blocked" | "current";
  readonly approvalAllowed: boolean;
  readonly compatibility: AdminUpdateCompatibility;
  readonly preflight: AdminUpdatePreflight;
  readonly blockers: readonly AdminUpdateBlocker[];
}

export interface AdminUpdateHistoryItem {
  readonly id: string;
  readonly occurredAt: string;
  readonly action: "approved";
  readonly targetRelease: string;
  readonly result: "recorded";
}

export interface AdminUpdateHistory {
  readonly items: readonly AdminUpdateHistoryItem[];
  readonly nextCursor: string | null;
}

export async function getAdminUpdateReadiness(client: ApiClient): Promise<AdminUpdateReadiness> {
  const response = await client.get<AdminUpdateReadiness>("/admin/updates/readiness");
  return response.data;
}

export async function getAdminUpdateHistory(client: ApiClient, input: { readonly cursor?: string; readonly limit?: number } = {}): Promise<AdminUpdateHistory> {
  const query = new URLSearchParams();
  if (input.cursor !== undefined) query.set("cursor", input.cursor);
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  const response = await client.get<AdminUpdateHistory>(`/admin/updates/history${query.size === 0 ? "" : `?${query.toString()}`}`);
  return response.data;
}
