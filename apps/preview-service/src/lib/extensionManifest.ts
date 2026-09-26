export type ExtensionCapability =
  | "commands.register"
  | "languages.diagnostics"
  | "workspace.read"
  | "workspace.write";

export interface SignedExtensionManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  entrypoint: string;
  integrity: string;
  activationEvents: string[];
  capabilities: ExtensionCapability[];
  signature: string;
}

const TRUSTED_EXTENSION_KEY: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "XTL6LG8s2jvZVJznuIKP-yt2ehb9Z0LgTF_UXIdzkus",
  y: "q4uxGkzPsIgnCSjOGPdeI0ZHp268wvrR79lUuz2Cq4k"
};

const BUILTIN_IMPLEMENTATIONS: Record<string, string> = {
  "builtin:workspace-tools": "builtin:workspace-tools@1.0.0"
};

const ALLOWED_CAPABILITIES = new Set<ExtensionCapability>([
  "commands.register",
  "languages.diagnostics",
  "workspace.read",
  "workspace.write"
]);

export const BUILTIN_WORKSPACE_TOOLS_MANIFEST: SignedExtensionManifest = {
  schemaVersion: 1,
  id: "cargo.builtin.workspace-tools",
  version: "1.0.0",
  entrypoint: "builtin:workspace-tools",
  integrity: "sha256-lYjKzEzqXAavUxeAx20HrcCRiG7U2hxHmddI_aaGck4",
  activationEvents: ["onStartup"],
  capabilities: ["commands.register", "languages.diagnostics"],
  signature: "p1-lW9MauldvQuOZygNb7CKUu-Oz_Acu-NNAaWpT11CZBuyFKM9kqBEfXNqDzdSKsFLOspgeWjQKrx0Yt6tjTg"
};

export async function verifyExtensionManifest(manifest: SignedExtensionManifest): Promise<void> {
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported extension manifest schema.");
  if (!manifest.id || !manifest.version) throw new Error("Extension identity is required.");
  if (!manifest.activationEvents.every((event) => event === "onStartup" || event.startsWith("onCommand:"))) {
    throw new Error("Extension activation event is not permitted.");
  }
  for (const capability of manifest.capabilities) {
    if (!ALLOWED_CAPABILITIES.has(capability)) throw new Error(`Extension capability is not permitted: ${capability}`);
  }
  const implementation = BUILTIN_IMPLEMENTATIONS[manifest.entrypoint];
  if (!implementation) throw new Error("Extension entrypoint is not in the built-in allowlist.");
  const integrity = `sha256-${base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(implementation)))}`;
  if (integrity !== manifest.integrity) throw new Error("Extension entrypoint integrity mismatch.");

  const key = await crypto.subtle.importKey(
    "jwk",
    TRUSTED_EXTENSION_KEY,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    fromBase64Url(manifest.signature),
    new TextEncoder().encode(canonicalManifestPayload(manifest))
  );
  if (!valid) throw new Error("Extension manifest signature is invalid.");
}

export function assertExtensionCapability(
  manifest: SignedExtensionManifest,
  capability: ExtensionCapability
): void {
  if (!manifest.capabilities.includes(capability)) {
    throw new Error(`Extension ${manifest.id} was not granted ${capability}.`);
  }
}

function canonicalManifestPayload(manifest: SignedExtensionManifest): string {
  return JSON.stringify({
    activationEvents: manifest.activationEvents,
    capabilities: manifest.capabilities,
    entrypoint: manifest.entrypoint,
    id: manifest.id,
    integrity: manifest.integrity,
    schemaVersion: manifest.schemaVersion,
    version: manifest.version
  });
}

function base64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
