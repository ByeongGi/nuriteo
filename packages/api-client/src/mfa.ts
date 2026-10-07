import { mutationOptions } from "./browser-mutation.ts";
import type { BrowserMutationOptions } from "./browser-mutation.ts";
import {
  type ApiEmptyResult,
  type ApiResult,
  type DomainRequestOptions,
  requireNoContent,
  validatedResult
} from "./domain.ts";
import type { ApiClient } from "./types.ts";
import {
  readBoolean,
  readBoundedArray,
  readBoundedString,
  readEnum,
  readExactRecord,
  readNullableUtcTimestamp,
  readPositiveInteger,
  readUuidV7
} from "./validation.ts";

const POLICY_MODES = ["off", "administrators", "all_local_users"] as const;
const NOTIFICATION_STATES = ["none", "grace_period", "overdue"] as const;
const MAX_RECOVERY_CODES = 20;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/u;
const POPULATION_PROOF = /^[A-Za-z0-9_-]{43}$/u;

export interface MfaMutationOptions extends BrowserMutationOptions {
  readonly idempotencyKey: string;
}

export type MfaPolicyMode = (typeof POLICY_MODES)[number];
export type MfaNotificationState = (typeof NOTIFICATION_STATES)[number];

export interface MfaStatus {
  readonly localAccount: boolean;
  readonly enrolled: boolean;
  readonly pendingEnrollment: boolean;
  readonly recoveryCodesRemaining: number;
  readonly policyMode: MfaPolicyMode;
  readonly gracePeriodDays: number;
  readonly required: boolean;
  readonly deadlineAt: string | null;
  readonly restricted: boolean;
  readonly notificationState: MfaNotificationState;
}

export interface MfaEnrollmentStart {
  readonly credentialId: string;
  readonly manualSecret: string;
  readonly provisioningUri: string;
}

export interface MfaEnrollmentComplete {
  readonly recoveryCodes: readonly string[];
}

export interface MfaPolicy {
  readonly mode: MfaPolicyMode;
  readonly gracePeriodDays: number;
  readonly version: number;
  readonly affectedUsers: number;
  readonly immediatelyRestrictedUsers: number;
  readonly enrolledLocalAdministrators: number;
}

export interface MfaPolicyImpact {
  readonly mode: MfaPolicyMode;
  readonly gracePeriodDays: number;
  readonly policyVersion: number;
  readonly affectedUsers: number;
  readonly unenrolledUsers: number;
  readonly immediatelyRestrictedUsers: number;
  readonly enrolledLocalAdministrators: number;
  readonly populationProof: string;
}

export interface MfaResetTarget {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly credentialGeneration: string;
}

export async function getMfaStatus(client: ApiClient, options: DomainRequestOptions = {}): Promise<ApiResult<MfaStatus>> {
  return validatedResult(await client.get<unknown>("/mfa", options), parseStatus);
}

export async function beginMfaEnrollment(client: ApiClient, options: MfaMutationOptions): Promise<ApiResult<MfaEnrollmentStart>> {
  return validatedResult(await client.post<unknown>("/mfa/enrollment", undefined, mfaMutationOptions(options)), parseEnrollmentStart);
}

export async function confirmMfaEnrollment(
  client: ApiClient,
  input: { readonly credentialId: string; readonly code: string },
  options: MfaMutationOptions
): Promise<ApiResult<MfaEnrollmentComplete>> {
  return validatedResult(
    await client.post<unknown, typeof input>("/mfa/enrollment/confirm", input, mfaMutationOptions(options)),
    parseEnrollmentComplete
  );
}

export async function challengeMfa(client: ApiClient, code: string, options: MfaMutationOptions): Promise<ApiEmptyResult> {
  return requireNoContent(await client.post<unknown, { readonly code: string }>("/mfa/challenge", { code }, mfaMutationOptions(options)));
}

export async function recoverMfa(client: ApiClient, code: string, options: MfaMutationOptions): Promise<ApiEmptyResult> {
  return requireNoContent(await client.post<unknown, { readonly code: string }>("/mfa/recovery", { code }, mfaMutationOptions(options)));
}

export async function disableMfa(client: ApiClient, options: BrowserMutationOptions): Promise<ApiEmptyResult> {
  return requireNoContent(await client.delete<unknown>("/mfa/enrollment", mutationOptions(options)));
}

export async function getMfaPolicy(client: ApiClient, options: DomainRequestOptions = {}): Promise<ApiResult<MfaPolicy>> {
  return validatedResult(await client.get<unknown>("/admin/mfa-policy", options), parsePolicy);
}

export async function updateMfaPolicy(
  client: ApiClient,
  input: {
    readonly mode: MfaPolicyMode;
    readonly gracePeriodDays: number;
    readonly version: number;
    readonly populationProof: string;
  },
  options: BrowserMutationOptions
): Promise<ApiResult<MfaPolicy>> {
  const headers = new Headers({ "if-match": `"mfa-policy-v${input.version}"` });
  return validatedResult(
    await client.patch<unknown, {
      readonly mode: MfaPolicyMode;
      readonly gracePeriodDays: number;
      readonly populationProof: string;
    }>(
      "/admin/mfa-policy",
      {
        mode: input.mode,
        gracePeriodDays: input.gracePeriodDays,
        populationProof: requirePopulationProof(input.populationProof)
      },
      mutationOptions(options, headers)
    ),
    parsePolicy
  );
}

export async function previewMfaPolicy(
  client: ApiClient,
  input: { readonly mode: MfaPolicyMode; readonly gracePeriodDays: number; readonly version: number },
  options: BrowserMutationOptions
): Promise<ApiResult<MfaPolicyImpact>> {
  const headers = new Headers({ "if-match": `"mfa-policy-v${input.version}"` });
  return validatedResult(
    await client.post<unknown, { readonly mode: MfaPolicyMode; readonly gracePeriodDays: number }>(
      "/admin/mfa-policy/preview",
      { mode: input.mode, gracePeriodDays: input.gracePeriodDays },
      mutationOptions(options, headers)
    ),
    parsePolicyImpact
  );
}

export async function searchMfaResetTargets(
  client: ApiClient,
  query: string,
  options: DomainRequestOptions = {}
): Promise<ApiResult<readonly MfaResetTarget[]>> {
  const value = query.trim();
  if (value.length < 2 || value.length > 200) throw new TypeError("invalid MFA reset search");
  return validatedResult(
    await client.get<unknown>(`/admin/mfa-reset-targets?query=${encodeURIComponent(value)}`, options),
    parseResetTargets
  );
}

export async function resetUserMfa(
  client: ApiClient,
  target: MfaResetTarget,
  options: BrowserMutationOptions
): Promise<ApiEmptyResult> {
  const record = { id: target.userId, generation: target.credentialGeneration };
  const canonicalUserId = readUuidV7(record, "id");
  const credentialGeneration = readUuidV7(record, "generation");
  return requireNoContent(await client.post<unknown, { readonly credentialGeneration: string; readonly confirmation: string }>(
    `/admin/users/${canonicalUserId}/mfa/reset`,
    { credentialGeneration, confirmation: target.email },
    mutationOptions(options)
  ));
}

function parseStatus(value: unknown): MfaStatus {
  const record = readExactRecord(value, [
    "deadlineAt", "enrolled", "gracePeriodDays", "localAccount", "notificationState",
    "pendingEnrollment", "policyMode", "recoveryCodesRemaining", "required", "restricted"
  ]);
  return {
    localAccount: readBoolean(record, "localAccount"),
    enrolled: readBoolean(record, "enrolled"),
    pendingEnrollment: readBoolean(record, "pendingEnrollment"),
    recoveryCodesRemaining: nonNegativeInteger(record.recoveryCodesRemaining, MAX_RECOVERY_CODES),
    policyMode: readEnum(record, "policyMode", POLICY_MODES),
    gracePeriodDays: nonNegativeInteger(record.gracePeriodDays, 30),
    required: readBoolean(record, "required"),
    deadlineAt: readNullableUtcTimestamp(record, "deadlineAt"),
    restricted: readBoolean(record, "restricted"),
    notificationState: readEnum(record, "notificationState", NOTIFICATION_STATES)
  };
}

function parseEnrollmentStart(value: unknown): MfaEnrollmentStart {
  const record = readExactRecord(value, ["credentialId", "manualSecret", "provisioningUri"]);
  const manualSecret = readBoundedString(record, "manualSecret", 256);
  const provisioningUri = readBoundedString(record, "provisioningUri", 2_048);
  if (!/^[A-Z2-7]+$/u.test(manualSecret) || !provisioningUri.startsWith("otpauth://totp/")) {
    throw new TypeError("invalid enrollment payload");
  }
  return { credentialId: readUuidV7(record, "credentialId"), manualSecret, provisioningUri };
}

function parseEnrollmentComplete(value: unknown): MfaEnrollmentComplete {
  const record = readExactRecord(value, ["recoveryCodes"]);
  const recoveryCodes = readBoundedArray(record, "recoveryCodes", MAX_RECOVERY_CODES).map((code) => {
    const item = { code };
    return readBoundedString(item, "code", 128);
  });
  if (recoveryCodes.length === 0 || new Set(recoveryCodes).size !== recoveryCodes.length) {
    throw new TypeError("invalid recovery codes");
  }
  return { recoveryCodes };
}

function parsePolicy(value: unknown): MfaPolicy {
  const record = readExactRecord(value, [
    "affectedUsers", "enrolledLocalAdministrators", "gracePeriodDays",
    "immediatelyRestrictedUsers", "mode", "version"
  ]);
  return {
    mode: readEnum(record, "mode", POLICY_MODES),
    gracePeriodDays: nonNegativeInteger(record.gracePeriodDays, 30),
    version: readPositiveInteger(record, "version"),
    affectedUsers: nonNegativeInteger(record.affectedUsers),
    immediatelyRestrictedUsers: nonNegativeInteger(record.immediatelyRestrictedUsers),
    enrolledLocalAdministrators: nonNegativeInteger(record.enrolledLocalAdministrators)
  };
}

function parsePolicyImpact(value: unknown): MfaPolicyImpact {
  const record = readExactRecord(value, [
    "affectedUsers", "enrolledLocalAdministrators", "gracePeriodDays", "immediatelyRestrictedUsers",
    "mode", "policyVersion", "populationProof", "unenrolledUsers"
  ]);
  return {
    mode: readEnum(record, "mode", POLICY_MODES),
    gracePeriodDays: nonNegativeInteger(record.gracePeriodDays, 30),
    policyVersion: readPositiveInteger(record, "policyVersion"),
    affectedUsers: nonNegativeInteger(record.affectedUsers),
    unenrolledUsers: nonNegativeInteger(record.unenrolledUsers),
    immediatelyRestrictedUsers: nonNegativeInteger(record.immediatelyRestrictedUsers),
    enrolledLocalAdministrators: nonNegativeInteger(record.enrolledLocalAdministrators),
    populationProof: requirePopulationProof(readBoundedString(record, "populationProof", 43))
  };
}

function requirePopulationProof(value: string): string {
  if (!POPULATION_PROOF.test(value)) throw new TypeError("invalid MFA policy population proof");
  return value;
}

function parseResetTargets(value: unknown): readonly MfaResetTarget[] {
  const collection = readExactRecord(value, ["items"]);
  return readBoundedArray(collection, "items", 20).map((item) => {
    const record = readExactRecord(item, ["credentialGeneration", "displayName", "email", "userId"]);
    return {
      userId: readUuidV7(record, "userId"),
      email: readBoundedString(record, "email", 320),
      displayName: readBoundedString(record, "displayName", 200),
      credentialGeneration: readUuidV7(record, "credentialGeneration")
    };
  });
}

function nonNegativeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new TypeError("invalid integer");
  }
  return value as number;
}

function mfaMutationOptions({ idempotencyKey, ...options }: MfaMutationOptions) {
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new TypeError("invalid idempotency key");
  return mutationOptions(options, { "idempotency-key": idempotencyKey });
}
