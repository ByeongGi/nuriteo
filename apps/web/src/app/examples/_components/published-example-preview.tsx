"use client";

import type { PublicPublishedExample } from "@nuriteo/api-client";
import { useEffect, useRef, useState } from "react";

import { Button } from "../../../components/ui/button.tsx";
import { createRetryableLazyFeature } from "../../../lib/retryable-lazy-feature.ts";
import type { PublicPreviewContentError } from "../../../published-example/public-preview-content.ts";
import type { RuntimeAdapter } from "../../../runtime/runtime-adapter.ts";
import type { PreviewOriginConfiguration } from "../../../runtime/preview-origin-contract.ts";
import type { SubdomainPreviewBridge } from "../../../runtime/subdomain-preview-bridge.ts";

const RUNTIME_BOOT_TIMEOUT_MS = 10_000;
const RUNTIME_RELAY_TIMEOUT_MS = 10_000;
const RUNTIME_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;

const runtimeFeature = createRetryableLazyFeature(
  () => import("../../../runtime/runtime-adapter.ts")
);
const contentFeature = createRetryableLazyFeature(
  () => import("../../../published-example/public-preview-content.ts")
);
const bridgeFeature = createRetryableLazyFeature(
  () => import("../../../runtime/subdomain-preview-bridge.ts")
);
const assetFeature = createRetryableLazyFeature(
  () => import("../../../runtime/runtime-assets.ts")
);
type BridgeFeature = Awaited<ReturnType<typeof bridgeFeature.load>>;

interface PublicRuntimeBinding {
  readonly internalProjectIdentity: string;
  readonly internalPreviewUrl: string;
}

interface PublishedExamplePreviewProps {
  readonly assetRevision?: string;
  readonly example: PublicPublishedExample;
  readonly previewConfiguration: PreviewOriginConfiguration;
}

type PreviewStatus = "idle" | "loading" | "running" | "stopping";

export function PublishedExamplePreview({
  assetRevision,
  example,
  previewConfiguration
}: PublishedExamplePreviewProps) {
  const adapterRef = useRef<RuntimeAdapter | undefined>(undefined);
  const bridgeRef = useRef<SubdomainPreviewBridge | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const recoveryRef = useRef<Promise<void> | null>(null);
  const operationRef = useRef(0);
  const unmountedRef = useRef(false);
  const [error, setError] = useState<string>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [status, setStatus] = useState<PreviewStatus>("idle");

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      operationRef.current += 1;
      abortRef.current?.abort();
      const bridge = bridgeRef.current;
      const adapter = adapterRef.current;
      bridgeRef.current = undefined;
      adapterRef.current = undefined;
      void bridge?.dispose();
      void adapter?.dispose();
    };
  }, []);

  async function startPreview(): Promise<void> {
    if (status !== "idle") return;
    if (previewConfiguration.status === "disabled") {
      setError(previewConfiguration.message);
      return;
    }

    const operation = operationRef.current + 1;
    operationRef.current = operation;
    const abort = new AbortController();
    abortRef.current = abort;
    setError(undefined);
    setStatus("loading");
    let adapter: RuntimeAdapter | undefined;
    let bridge: SubdomainPreviewBridge | undefined;
    try {
      const [runtime, content, bridgeModule, assets] = await Promise.all([
        runtimeFeature.load(),
        contentFeature.load(),
        bridgeFeature.load(),
        assetFeature.load()
      ]);
      const [revision, publishedContent] = await Promise.all([
        assets.resolveRuntimeAssetRevision(assetRevision, abort.signal, "omit"),
        content.loadPublicPreviewContent(
          { publicId: example.publicId, versionNumber: example.versionNumber },
          { signal: abort.signal }
        )
      ]);
      ensureCurrent(operation, abort.signal);

      const projectId = temporaryUuidV7();
      const storageScopeId = temporaryUuidV7();
      adapter = runtime.createRuntimeAdapter();
      adapterRef.current = adapter;
      const origin = globalThis.location.origin;
      const base = `/runtime/${revision}`;
      await adapter.mount({
        project: {
          id: projectId,
          storageScopeId,
          workspaceScopeId: storageScopeId,
          displayName: example.name
        },
        assets: {
          systemWorkerUrl: new URL(`${base}/system-worker.js`, origin),
          processWorkerUrl: new URL(`${base}/process-worker.js`, origin),
          systemWasmUrl: new URL(`${base}/system.wasm`, origin),
          previewServiceWorkerUrl: new URL(`${base}/preview-sw.js`, origin)
        },
        policy: {
          bootTimeoutMs: RUNTIME_BOOT_TIMEOUT_MS,
          relayTimeoutMs: RUNTIME_RELAY_TIMEOUT_MS,
          memoryLimitBytes: RUNTIME_MEMORY_LIMIT_BYTES
        },
        reportDiagnostic(diagnostic) {
          if (!unmountedRef.current && diagnostic.severity === "error") {
            setError("The isolated public Preview stopped safely.");
          }
        }
      });
      ensureCurrent(operation, abort.signal);
      await adapter.workspace.materializeBundle(publishedContent.files);
      const runtimeState = await adapter.workflow.start();
      if (runtimeState.previewUrl === null) throw new Error("Preview URL unavailable");
      ensureCurrent(operation, abort.signal);

      bridge = await createBridge(bridgeModule, {
        internalProjectIdentity: `${storageScopeId}:${projectId}`,
        internalPreviewUrl: runtimeState.previewUrl
      });
      ensureCurrent(operation, abort.signal);
      bridgeRef.current = bridge;
      setPreviewUrl(bridge.url);
      setStatus("running");
    } catch (caught) {
      if (bridge !== undefined && bridgeRef.current !== bridge) void bridge.dispose();
      if (adapter !== undefined && adapterRef.current !== adapter) void adapter.dispose();
      if (!unmountedRef.current && operationRef.current === operation) {
        setError(previewErrorMessage(caught));
        setStatus("idle");
        setPreviewUrl(undefined);
        await releaseOwnedRuntime();
      }
    } finally {
      if (abortRef.current === abort) abortRef.current = undefined;
    }
  }

  async function stopPreview(): Promise<void> {
    if (status === "idle" || status === "stopping") return;
    operationRef.current += 1;
    abortRef.current?.abort();
    setStatus("stopping");
    setPreviewUrl(undefined);
    await releaseOwnedRuntime();
    if (!unmountedRef.current) setStatus("idle");
  }

  async function releaseOwnedRuntime(): Promise<void> {
    const bridge = bridgeRef.current;
    const adapter = adapterRef.current;
    bridgeRef.current = undefined;
    adapterRef.current = undefined;
    await Promise.allSettled([bridge?.dispose(), adapter?.dispose()]);
  }

  async function createBridge(
    bridgeModule: BridgeFeature,
    binding: PublicRuntimeBinding
  ): Promise<SubdomainPreviewBridge> {
    if (previewConfiguration.status === "disabled") throw new Error("Preview unavailable");
    let created: SubdomainPreviewBridge | undefined;
    created = await bridgeModule.createPublishedExamplePreviewBridge({
      configuration: previewConfiguration,
      internalProjectIdentity: binding.internalProjectIdentity,
      internalPreviewUrl: binding.internalPreviewUrl,
      publicId: example.publicId,
      versionNumber: example.versionNumber,
      onDiagnostic() {
        if (!unmountedRef.current) setError("The isolated public Preview stopped safely.");
      },
      onRecoveryRequired() {
        if (created !== undefined) recoverPreview(created, bridgeModule, binding);
      }
    });
    return created;
  }

  function recoverPreview(
    staleBridge: SubdomainPreviewBridge,
    bridgeModule: BridgeFeature,
    binding: PublicRuntimeBinding
  ): void {
    if (
      recoveryRef.current !== null
      || bridgeRef.current !== staleBridge
      || adapterRef.current === undefined
      || unmountedRef.current
    ) return;
    const operation = operationRef.current;
    const adapter = adapterRef.current;
    const recovery = (async () => {
      bridgeRef.current = undefined;
      setPreviewUrl(undefined);
      setError(undefined);
      await staleBridge.dispose();
      if (
        unmountedRef.current
        || operationRef.current !== operation
        || adapterRef.current !== adapter
      ) return;
      const nextBridge = await createBridge(bridgeModule, binding);
      if (
        unmountedRef.current
        || operationRef.current !== operation
        || adapterRef.current !== adapter
      ) {
        await nextBridge.dispose();
        return;
      }
      bridgeRef.current = nextBridge;
      setPreviewUrl(nextBridge.url);
    })().catch(() => {
      if (!unmountedRef.current && operationRef.current === operation) {
        setError("The isolated public Preview could not reconnect. Stop it and run a fresh session.");
      }
    }).finally(() => {
      recoveryRef.current = null;
    });
    recoveryRef.current = recovery;
  }

  function ensureCurrent(operation: number, signal: AbortSignal): void {
    if (unmountedRef.current || signal.aborted || operationRef.current !== operation) {
      throw new DOMException("Public Preview startup was cancelled.", "AbortError");
    }
  }

  const disabled = previewConfiguration.status === "disabled";
  return (
    <section className="mt-8 border-t border-muted-border pt-7" aria-labelledby="published-preview-title">
      <div className="flex flex-wrap items-start justify-between gap-4 text-left">
        <div>
          <h3 id="published-preview-title" className="m-0 text-base font-semibold text-foreground">
            Isolated Preview
          </h3>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Runs this immutable public version in a temporary browser Runtime on a separate origin. Account cookies, authorization, CSRF, environment values, and storage credentials are not sent.
          </p>
        </div>
        {status === "running" || status === "loading" ? (
          <Button type="button" variant="secondary" onClick={() => void stopPreview()}>
            {status === "loading" ? "Cancel Preview" : "Stop Preview"}
          </Button>
        ) : (
          <Button type="button" disabled={disabled || status === "stopping"} onClick={() => void startPreview()}>
            {status === "stopping" ? "Stopping…" : "Run isolated Preview"}
          </Button>
        )}
      </div>

      {disabled ? (
        <p className="mt-4 rounded-md border border-muted-border bg-subtle p-3 text-sm text-muted-foreground" role="status">
          {previewConfiguration.message} Same-origin Preview is disabled.
        </p>
      ) : null}
      {status === "loading" ? (
        <p className="mt-4 text-sm text-muted-foreground" role="status">
          Verifying the immutable bundle and starting an isolated Runtime…
        </p>
      ) : null}
      {error !== undefined ? (
        <p className="mt-4 rounded-md border border-danger/30 bg-danger/5 p-3 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {previewUrl !== undefined ? (
        <div
          className="mt-5 overflow-hidden rounded-lg border border-muted-border bg-white"
          data-public-preview-url={previewUrl}
        >
          <iframe
            ref={(frame) => bridgeRef.current?.attach(frame?.contentWindow ?? null)}
            title={`${example.name} public Preview`}
            className="h-[34rem] w-full border-0 bg-white"
            src={previewUrl}
            sandbox="allow-scripts allow-same-origin"
            allow="cross-origin-isolated"
            referrerPolicy="no-referrer"
          />
        </div>
      ) : null}
    </section>
  );
}

function previewErrorMessage(error: unknown): string {
  const contentError = error as Partial<PublicPreviewContentError> | undefined;
  if (contentError?.code === "PUBLIC_PREVIEW_LIMIT_EXCEEDED") {
    return "This example exceeds the browser Preview limit. You can still download the verified archive.";
  }
  if (contentError?.code === "PUBLIC_PREVIEW_CONTENT_UNAVAILABLE") {
    return "This published version is no longer available.";
  }
  if (contentError?.code === "PUBLIC_PREVIEW_INTEGRITY_FAILED") {
    return "The public bundle failed integrity verification and was not executed.";
  }
  return "The isolated public Preview could not start. No account credential was shared; retry with a fresh session.";
}

function temporaryUuidV7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let timestamp = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
