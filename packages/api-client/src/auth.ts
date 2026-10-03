import { ApiConfigurationError } from "./errors.ts";
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
  readBoundedString,
  readExactRecord,
  readUtcTimestamp,
  readUuidV7
} from "./validation.ts";

const MAX_CSRF_BYTES = 512;

export interface CreateSessionInput {
  readonly email: string;
  readonly password: string;
}

export interface DeleteSessionOptions extends DomainRequestOptions {
  readonly csrfToken: string;
}

export interface MeView {
  readonly user: MeUser;
  readonly session: MeSession;
}

export interface MeUser {
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
  readonly is_instance_admin: boolean;
}

export interface MeSession {
  readonly id: string;
  readonly last_seen_at: string;
  readonly idle_expires_at: string;
  readonly absolute_expires_at: string;
}

export async function createSession(
  client: ApiClient,
  input: CreateSessionInput,
  options: DomainRequestOptions = {}
): Promise<ApiEmptyResult> {
  const response = await client.post<unknown, CreateSessionInput>(
    "/auth/sessions",
    { email: input.email, password: input.password },
    options
  );
  return requireNoContent(response);
}

export async function deleteSession(
  client: ApiClient,
  { csrfToken, ...options }: DeleteSessionOptions
): Promise<ApiEmptyResult> {
  validateCsrfToken(csrfToken);
  const response = await client.delete<unknown>("/auth/session", {
    ...options,
    headers: { "x-csrf-token": csrfToken }
  });
  return requireNoContent(response);
}

export async function getCurrentUser(
  client: ApiClient,
  options: DomainRequestOptions = {}
): Promise<ApiResult<MeView>> {
  const response = await client.get<unknown>("/me", options);
  return validatedResult(response, parseMeView);
}

function parseMeView(value: unknown): MeView {
  const root = readExactRecord(value, ["session", "user"]);
  return {
    user: parseMeUser(root.user),
    session: parseMeSession(root.session)
  };
}

function parseMeUser(value: unknown): MeUser {
  const user = readExactRecord(value, [
    "display_name",
    "email",
    "id",
    "is_instance_admin"
  ]);
  return {
    id: readUuidV7(user, "id"),
    email: readBoundedString(user, "email", 320),
    display_name: readBoundedString(user, "display_name", 800, { maxCharacters: 200 }),
    is_instance_admin: readBoolean(user, "is_instance_admin")
  };
}

function parseMeSession(value: unknown): MeSession {
  const session = readExactRecord(value, [
    "absolute_expires_at",
    "id",
    "idle_expires_at",
    "last_seen_at"
  ]);
  const result = {
    id: readUuidV7(session, "id"),
    last_seen_at: readUtcTimestamp(session, "last_seen_at"),
    idle_expires_at: readUtcTimestamp(session, "idle_expires_at"),
    absolute_expires_at: readUtcTimestamp(session, "absolute_expires_at")
  };
  const lastSeen = Date.parse(result.last_seen_at);
  const idleExpiry = Date.parse(result.idle_expires_at);
  const absoluteExpiry = Date.parse(result.absolute_expires_at);
  if (lastSeen >= idleExpiry || idleExpiry > absoluteExpiry) {
    throw new TypeError("invalid Session order");
  }
  return result;
}

function validateCsrfToken(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > MAX_CSRF_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ApiConfigurationError("The CSRF credential is invalid.");
  }
}
