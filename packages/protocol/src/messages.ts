import type { FailedMessage, MessageDetails, ReadyMessage, RuntimeRole } from "./types.ts";

export const protocolVersion = 1;

export function createReadyMessage(role: RuntimeRole, details: MessageDetails = {}): ReadyMessage {
  return {
    type: "ready",
    protocolVersion,
    role,
    details
  };
}

export function createFailedMessage(role: RuntimeRole, error: unknown): FailedMessage {
  return {
    type: "failed",
    protocolVersion,
    role,
    error: error instanceof Error ? error.message : String(error)
  };
}
