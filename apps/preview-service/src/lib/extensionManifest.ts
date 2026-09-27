export type ExtensionCapability =
  | "commands.register"
  | "languages.diagnostics"
  | "workspace.read"
  | "workspace.write";

export type ExtensionActivationEvent = "onStartup" | `onCommand:${string}` | `onLanguage:${string}`;

export interface ExtensionContributions {
  commands?: Array<{ command: string; title: string }>;
  languages?: string[];
}

export interface SignedExtensionManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  entrypoint: string;
  integrity: string;
  activationEvents: ExtensionActivationEvent[];
  capabilities: ExtensionCapability[];
  contributes: ExtensionContributions;
  signature: string;
}

const TRUSTED_EXTENSION_KEY: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "6E5T3wYV--Cr2LmATPXJvpCFw_R1SbX6e8WmHTEns1A",
  y: "SmbCszoY7kcaAR0Zmj4IItpT-UDO2UYWINmbLvmRpdA"
};

const BUILTIN_IMPLEMENTATIONS: Record<string, string> = {
  "builtin:workspace-tools": "builtin:workspace-tools@2.0.0",
  "builtin:code-health": "builtin:code-health@1.0.0"
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
  version: "2.0.0",
  entrypoint: "builtin:workspace-tools",
  integrity: "sha256-TU4sNVSkYwPTmKS4NqoXln1MddWuxlBzJ2BrbvT1DK8",
  activationEvents: ["onStartup", "onCommand:cargo.workspaceTools.hello", "onCommand:cargo.workspaceTools.sortLines"],
  capabilities: ["commands.register", "workspace.read", "workspace.write"],
  contributes: {
    commands: [
      { command: "cargo.workspaceTools.hello", title: "Workspace Tools: Hello" },
      { command: "cargo.workspaceTools.sortLines", title: "Workspace Tools: Sort Lines" }
    ]
  },
  signature: "AB9a1NEDS8QU3-Mzv2_VgW1CyxFTE86jeFgjHRGccHU1y6nJOhcZ3D7mO800HJIZLF8DfhlMTyK5jmbWYF14Mg"
};

export const BUILTIN_CODE_HEALTH_MANIFEST: SignedExtensionManifest = {
  schemaVersion: 1,
  id: "cargo.builtin.code-health",
  version: "1.0.0",
  entrypoint: "builtin:code-health",
  integrity: "sha256-FhpitzNAbP3pj4iaXhTrtnfUx5fYAzD7Pfnehg9YjTI",
  activationEvents: ["onLanguage:typescript", "onLanguage:javascript"],
  capabilities: ["languages.diagnostics", "workspace.read"],
  contributes: { languages: ["typescript", "javascript"] },
  signature: "A8K-xqKgnEf5nRf2--GhTlCFZjY9aqqmN0vNYztOP5gxLtcWrXWu_AlVIR8NfuYf9pi5Bwvjlnhhje0Y71GdXA"
};

export const BUILTIN_EXTENSION_MANIFESTS = [BUILTIN_WORKSPACE_TOOLS_MANIFEST, BUILTIN_CODE_HEALTH_MANIFEST] as const;

export async function verifyExtensionManifest(manifest: SignedExtensionManifest): Promise<void> {
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported extension manifest schema.");
  if (!manifest.id || !manifest.version) throw new Error("Extension identity is required.");
  if (!manifest.activationEvents.every(isPermittedActivationEvent)) throw new Error("Extension activation event is not permitted.");
  for (const capability of manifest.capabilities) {
    if (!ALLOWED_CAPABILITIES.has(capability)) throw new Error(`Extension capability is not permitted: ${capability}`);
  }
  assertContributionsMatchCapabilities(manifest);
  const implementation = BUILTIN_IMPLEMENTATIONS[manifest.entrypoint];
  if (!implementation) throw new Error("Extension entrypoint is not in the built-in allowlist.");
  const integrity = `sha256-${base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(implementation)))}`;
  if (integrity !== manifest.integrity) throw new Error("Extension entrypoint integrity mismatch.");

  const key = await crypto.subtle.importKey("jwk", TRUSTED_EXTENSION_KEY, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    fromBase64Url(manifest.signature),
    new TextEncoder().encode(canonicalManifestPayload(manifest))
  );
  if (!valid) throw new Error("Extension manifest signature is invalid.");
}

export function assertExtensionCapability(manifest: SignedExtensionManifest, capability: ExtensionCapability): void {
  if (!manifest.capabilities.includes(capability)) throw new Error(`Extension ${manifest.id} was not granted ${capability}.`);
}

function isPermittedActivationEvent(event: string): event is ExtensionActivationEvent {
  return event === "onStartup"
    || /^onCommand:[a-zA-Z0-9][\w.-]+$/.test(event)
    || /^onLanguage:[a-zA-Z0-9][\w.+-]+$/.test(event);
}

function assertContributionsMatchCapabilities(manifest: SignedExtensionManifest): void {
  if (manifest.contributes.commands?.length && !manifest.capabilities.includes("commands.register")) {
    throw new Error("Command contributions require commands.register.");
  }
  if (manifest.contributes.languages?.length && !manifest.capabilities.includes("languages.diagnostics")) {
    throw new Error("Language contributions require languages.diagnostics.");
  }
  const commands = new Set<string>();
  for (const contribution of manifest.contributes.commands ?? []) {
    if (!contribution.command || !contribution.title || commands.has(contribution.command)) {
      throw new Error("Extension command contributions must be unique and named.");
    }
    commands.add(contribution.command);
  }
}

function canonicalManifestPayload(manifest: SignedExtensionManifest): string {
  return JSON.stringify({
    activationEvents: manifest.activationEvents,
    capabilities: manifest.capabilities,
    contributes: manifest.contributes,
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
