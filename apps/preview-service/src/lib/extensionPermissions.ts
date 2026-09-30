import type { ExtensionCapability, SignedExtensionManifest } from "./extensionManifest.ts";

const STORAGE_KEY = "nuriteo.extension-permissions.v1";

type PermissionState = { schemaVersion: 1; grants: Record<string, ExtensionCapability[]> };

export function loadExtensionPermissions(manifest: SignedExtensionManifest): ExtensionCapability[] {
  if (typeof localStorage === "undefined") return [...manifest.capabilities];
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as PermissionState | null;
    const saved = parsed?.schemaVersion === 1 ? parsed.grants[manifest.id] : undefined;
    return saved ? saved.filter((capability) => manifest.capabilities.includes(capability)) : [...manifest.capabilities];
  } catch {
    return [...manifest.capabilities];
  }
}

export function saveExtensionPermissions(manifest: SignedExtensionManifest, grants: ExtensionCapability[]): void {
  if (typeof localStorage === "undefined") return;
  let state: PermissionState = { schemaVersion: 1, grants: {} };
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as PermissionState | null;
    if (parsed?.schemaVersion === 1) state = parsed;
  } catch {
    // Replace malformed state with a versioned clean record.
  }
  state.grants[manifest.id] = grants.filter((capability) => manifest.capabilities.includes(capability));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
