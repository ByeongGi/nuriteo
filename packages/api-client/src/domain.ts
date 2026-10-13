import { ApiInvalidResponseError } from "./errors.ts";
import type { ApiResponse, BodylessRequestOptions } from "./types.ts";

export type DomainRequestOptions = Pick<
  BodylessRequestOptions,
  "headers" | "maxResponseBytes" | "signal" | "timeoutMs"
>;

export interface ApiResult<T> {
  readonly data: T;
  readonly status: number;
  readonly requestId: string | undefined;
}

export interface ApiEmptyResult {
  readonly status: 204;
  readonly requestId: string | undefined;
}

export function requireNoContent(response: ApiResponse<unknown>): ApiEmptyResult {
  if (response.status !== 204 || response.data !== undefined) {
    throw invalidResponse(response);
  }
  return {
    status: 204,
    requestId: response.requestId
  };
}

export function validatedResult<T>(
  response: ApiResponse<unknown>,
  validate: (value: unknown) => T
): ApiResult<T> {
  if (response.status !== 200) {
    throw invalidResponse(response);
  }
  try {
    return {
      data: validate(response.data),
      status: response.status,
      requestId: response.requestId
    };
  } catch (error) {
    if (error instanceof ApiInvalidResponseError) {
      throw error;
    }
    throw invalidResponse(response);
  }
}

export function validatedResultForStatus<T>(
  response: ApiResponse<unknown>,
  status: number,
  validate: (value: unknown) => T
): ApiResult<T> {
  if (response.status !== status) {
    throw invalidResponse(response);
  }
  try {
    return {
      data: validate(response.data),
      status: response.status,
      requestId: response.requestId
    };
  } catch (error) {
    if (error instanceof ApiInvalidResponseError) {
      throw error;
    }
    throw invalidResponse(response);
  }
}

export function invalidResponse(response: ApiResponse<unknown>): ApiInvalidResponseError {
  return new ApiInvalidResponseError(response.status, response.requestId);
}
