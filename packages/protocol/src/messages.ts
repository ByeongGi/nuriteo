export const protocolVersion = 1;

export function createReadyMessage(role, details = {}) {
  return {
    type: "ready",
    protocolVersion,
    role,
    details
  };
}

export function createFailedMessage(role, error) {
  return {
    type: "failed",
    protocolVersion,
    role,
    error: error && error.message ? error.message : String(error)
  };
}
