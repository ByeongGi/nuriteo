import type { ApiClient } from "@nuriteo/api-client";

export interface AdminMaintenanceStatus {
  readonly phase: "active" | "draining" | "maintenance";
  readonly activeWrites: number;
  readonly writeAdmissionOpen: boolean;
}

export async function getAdminMaintenanceStatus(
  client: ApiClient
): Promise<AdminMaintenanceStatus> {
  const response = await client.get<AdminMaintenanceStatus>("/admin/maintenance");
  return response.data;
}
