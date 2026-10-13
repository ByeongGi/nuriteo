import { NODE_PROFILE } from "./node-profile.ts";
import type { RuntimeValue } from "./types.ts";

type BindingProfile = { status: string; source: string; [key: string]: unknown };
type BindingMap = Record<string, RuntimeValue>;

export class UnsupportedBindingError extends Error {
  code: "ERR_NURITEO_UNSUPPORTED_BINDING";
  binding: string;
  profile: BindingProfile;

  constructor(name: string, profile: BindingProfile) {
    super(`Unsupported Node internal binding: ${name}`);
    this.name = "UnsupportedBindingError";
    this.code = "ERR_NURITEO_UNSUPPORTED_BINDING";
    this.binding = name;
    this.profile = profile;
  }
}

export function createInternalBindingRegistry(bindings: BindingMap = {}): (name: string) => RuntimeValue {
  return function internalBinding(name: string): RuntimeValue {
    const normalized = name.startsWith("node:") ? name.slice(5) : name;
    if (bindings[normalized]) return bindings[normalized];

    const profile = (NODE_PROFILE.builtins as Record<string, BindingProfile>)[normalized] || {
      status: "unknown",
      source: NODE_PROFILE.nodeVersion
    };
    throw new UnsupportedBindingError(normalized, profile);
  };
}
