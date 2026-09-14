import { NODE_PROFILE } from "./node-profile.ts";

export class UnsupportedBindingError extends Error {
  constructor(name, profile) {
    super(`Unsupported Node internal binding: ${name}`);
    this.name = "UnsupportedBindingError";
    this.code = "ERR_CARGO_CONTAINER_UNSUPPORTED_BINDING";
    this.binding = name;
    this.profile = profile;
  }
}

export function createInternalBindingRegistry(bindings = {}) {
  return function internalBinding(name) {
    const normalized = name.startsWith("node:") ? name.slice(5) : name;
    if (bindings[normalized]) return bindings[normalized];

    const profile = NODE_PROFILE.builtins[normalized] || {
      status: "unknown",
      source: NODE_PROFILE.nodeVersion
    };
    throw new UnsupportedBindingError(normalized, profile);
  };
}
