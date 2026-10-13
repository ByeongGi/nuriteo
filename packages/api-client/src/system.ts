import type { ApiClient, ApiResponse } from "./types.ts";

export interface VersionResponse {
  readonly version: string;
}

export function getVersion(client: ApiClient): Promise<ApiResponse<VersionResponse>> {
  return client.get<VersionResponse>("/version");
}
