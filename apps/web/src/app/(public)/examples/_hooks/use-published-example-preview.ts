"use client";

import { useEffect, useRef, useState } from "react";

import { createRetryableLazyFeature } from "@/lib/retryable-lazy-feature.ts";

import type { PublicPublishedExample } from "@nuriteo/api-client";
import type { PublicPreviewContentError } from "@/published-example/public-preview-content.ts";
import type { RuntimeAdapter } from "@/runtime/runtime-adapter.ts";
import type { PreviewOriginConfiguration } from "@/runtime/preview-origin-contract.ts";
import type { SubdomainPreviewBridge } from "@/runtime/subdomain-preview-bridge.ts";

const RUNTIME_BOOT_TIMEOUT_MS = 10_000;
const RUNTIME_RELAY_TIMEOUT_MS = 10_000;
const RUNTIME_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;

const runtimeFeature = createRetryableLazyFeature(
  () => import("@/runtime/runtime-adapter.ts")
);
const contentFeature = createRetryableLazyFeature(
  () => import("@/published-example/public-preview-content.ts")
);
const bridgeFeature = createRetryableLazyFeature(
  () => import("@/runtime/subdomain-preview-bridge.ts")
);
const assetFeature = createRetryableLazyFeature(
  () => import("@/runtime/runtime-assets.ts")
);
type BridgeFeature = Awaited<ReturnType<typeof bridgeFeature.load>>;

interface PublicRuntimeBinding {
  readonly internalProjectIdentity: string;
  readonly internalPreviewUrl: string;
}

interface PublishedExamplePreviewInput {
  readonly assetRevision?: string | undefined;
  readonly example: PublicPublishedExample;
  readonly previewConfiguration: PreviewOriginConfiguration;
}

type PreviewStatus = "idle" | "loading" | "running" | "stopping";

export function usePublishedExamplePreview({
  assetRevision,
  example,
  previewConfiguration
}: PublishedExamplePreviewInput) {
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
            setError("격리된 공개 미리보기를 안전하게 중지했습니다.");
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
        if (!unmountedRef.current) setError("격리된 공개 미리보기를 안전하게 중지했습니다.");
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
        setError("격리된 공개 미리보기에 다시 연결하지 못했습니다. 중지한 뒤 새 세션으로 실행하세요.");
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

  function attachPreviewFrame(frame: HTMLIFrameElement | null) {
    bridgeRef.current?.attach(frame?.contentWindow ?? null);
  }

  return {
    attachPreviewFrame,
    disabled: previewConfiguration.status === "disabled",
    error,
    previewUrl,
    startPreview,
    status,
    stopPreview
  };
}

function previewErrorMessage(error: unknown): string {
  const contentError = error as Partial<PublicPreviewContentError> | undefined;
  if (contentError?.code === "PUBLIC_PREVIEW_LIMIT_EXCEEDED") {
    return "이 예제는 브라우저 미리보기 제한을 초과합니다. 검증된 아카이브는 계속 다운로드할 수 있습니다.";
  }
  if (contentError?.code === "PUBLIC_PREVIEW_CONTENT_UNAVAILABLE") {
    return "이 게시 버전을 더 이상 사용할 수 없습니다.";
  }
  if (contentError?.code === "PUBLIC_PREVIEW_INTEGRITY_FAILED") {
    return "공개 번들의 무결성 검증에 실패하여 실행하지 않았습니다.";
  }
  return "격리된 공개 미리보기를 시작하지 못했습니다. 계정 자격 증명은 공유되지 않았습니다. 새 세션으로 다시 시도하세요.";
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
