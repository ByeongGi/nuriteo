import {
  type ApiResult,
  type DomainRequestOptions,
  validatedResult
} from "./domain.ts";
import type { ApiClient } from "./types.ts";
import { readBoolean, readExactRecord } from "./validation.ts";

export interface SetupStatus {
  readonly bootstrapRequired: boolean;
}

export async function getSetupStatus(
  client: ApiClient,
  options: DomainRequestOptions = {}
): Promise<ApiResult<SetupStatus>> {
  const response = await client.get<unknown>("/setup/status", options);
  return validatedResult(response, parseSetupStatus);
}

function parseSetupStatus(value: unknown): SetupStatus {
  const status = readExactRecord(value, ["bootstrapRequired"]);
  return {
    bootstrapRequired: readBoolean(status, "bootstrapRequired")
  };
}
