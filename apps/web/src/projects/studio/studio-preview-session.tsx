"use client";

import type { FormEvent } from "react";
import { useCallback, useEffect } from "react";

import { Button } from "#src/components/ui/button.tsx";
import { Input } from "#src/components/ui/input.tsx";
import { appendStudioConsole, freshServerLogLines, studioConsoleSourceLabel } from "#src/projects/studio/preview-console.ts";
import type { StudioConsoleEntry } from "#src/projects/studio/preview-console.ts";
import { previewConsoleTone } from "#src/projects/studio/studio-shell-labels.ts";
import { PREVIEW_WINDOW_CLOSED_POLL_MS, PREVIEW_WINDOW_CONNECT_TIMEOUT_MS, type StudioShellSession } from "#src/projects/studio/studio-shell-session.ts";
import { createPreviewHistory, movePreviewHistory, normalizePreviewAddress, recordPreviewHistory } from "#src/runtime/preview-address.ts";
import { hotUpdatePreviewBridges } from "#src/runtime/preview-hot-update.ts";
import { createPreviewWindowUrl } from "#src/runtime/preview-origin-contract.ts";
import type { RuntimeAdapter } from "#src/runtime/runtime-adapter.ts";
import { createSubdomainPreviewBridge } from "#src/runtime/subdomain-preview-bridge.ts";
import type { PreviewChangeKind, SubdomainPreviewBridge } from "#src/runtime/subdomain-preview-bridge.ts";

export function useStudioPreview(session: StudioShellSession): void {
  const {
    adapterRef,
    isolatedPreviewUrl,
    previewAddress,
    previewAddressEditingRef,
    previewBridgeFactory,
    previewBridgeOperationRef,
    previewBridgeRef,
    previewCancelRequestedRef,
    previewConfiguration,
    previewConsoleIdRef,
    previewFrameRef,
    previewHistory,
    previewRecoveryRef,
    previewWindowBridgesRef,
    previewWindowDisposersRef,
    previousServerLogsRef,
    project,
    runtime,
    setBottomPanel,
    setError,
    setIsPreviewOpen,
    setIsRunningPreview,
    setIsTerminalOpen,
    setIsolatedPreviewUrl,
    setPreviewAddress,
    setPreviewConsole,
    setPreviewHistory,
    setPreviewRefreshFailed,
    setRuntime,
    terminal,
    unmountedRef,
    workspaceScope
  } = session;
  function hotUpdatePreviews(path: string, changeKind: PreviewChangeKind = "content"): void {
    hotUpdatePreviewBridges(previewBridgeRef.current, previewWindowBridgesRef.current, path, changeKind);
  }

  async function runPreview() {
    const adapter = adapterRef.current;
    if (!adapter) return;
    if (previewConfiguration.status === "disabled") {
      setError(previewConfiguration.message);
      return;
    }
    setError(undefined);
    setPreviewRefreshFailed(false);
    setIsPreviewOpen(true);
    await startPreview(adapter);
  }

  const attachPreviewFrame = useCallback((frame: HTMLIFrameElement | null) => {
    previewFrameRef.current = frame;
    previewBridgeRef.current?.attach(frame?.contentWindow ?? null);
  }, []);

  function refreshPreview(): void {
    const frameWindow = previewFrameRef.current?.contentWindow;
    if (!frameWindow || !isolatedPreviewUrl) return;
    setError(undefined);
    setPreviewRefreshFailed(false);
    frameWindow.postMessage(
      { type: "nuriteo-preview:reload", version: 1 },
      new URL(isolatedPreviewUrl).origin
    );
  }

  function postPreviewNavigation(path: string): void {
    const frameWindow = previewFrameRef.current?.contentWindow;
    if (!frameWindow || !isolatedPreviewUrl) return;
    frameWindow.postMessage(
      { path, type: "nuriteo-preview:navigate", version: 1 },
      new URL(isolatedPreviewUrl).origin
    );
  }

  function submitPreviewAddress(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const path = normalizePreviewAddress(previewAddress);
    if (!path) {
      setError("미리보기 주소는 이 프로젝트의 경로만 사용할 수 있습니다.");
      return;
    }
    setError(undefined);
    setPreviewRefreshFailed(false);
    previewAddressEditingRef.current = false;
    setPreviewAddress(path);
    setPreviewHistory((current) => recordPreviewHistory(current, path));
    postPreviewNavigation(path);
  }

  function movePreview(direction: -1 | 1): void {
    const next = movePreviewHistory(previewHistory, direction);
    if (next === previewHistory) return;
    const path = next.entries[next.index] ?? "/";
    setPreviewHistory(next);
    setPreviewAddress(path);
    previewAddressEditingRef.current = false;
    postPreviewNavigation(path);
  }

  useEffect(() => {
    if (!isolatedPreviewUrl) {
      setPreviewHistory(createPreviewHistory());
      setPreviewAddress("/");
      return;
    }
    const origin = new URL(isolatedPreviewUrl).origin;
    const receiveLocation = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== previewFrameRef.current?.contentWindow) return;
      const data = event.data;
      if (typeof data !== "object" || data === null) return;
      const record = data as Record<string, unknown>;
      if (record.type !== "nuriteo-preview:location" || record.version !== 1 || typeof record.path !== "string") return;
      const path = normalizePreviewAddress(record.path);
      if (!path) return;
      setPreviewHistory((current) => recordPreviewHistory(current, path));
      if (!previewAddressEditingRef.current) setPreviewAddress(path);
    };
    globalThis.addEventListener("message", receiveLocation);
    return () => globalThis.removeEventListener("message", receiveLocation);
  }, [isolatedPreviewUrl]);

  async function stopPreviewPort(port: number): Promise<void> {
    const adapter = adapterRef.current;
    if (!adapter) return;
    setError(undefined);
    if (!adapter.workflow.stopPreview(port)) {
      setError(`포트 ${port}의 개발 서버를 찾지 못했습니다.`);
      return;
    }
    previewBridgeOperationRef.current += 1;
    const bridge = previewBridgeRef.current;
    previewBridgeRef.current = undefined;
    setIsolatedPreviewUrl(undefined);
    await bridge?.dispose();
    if (!unmountedRef.current && adapterRef.current === adapter) {
      setRuntime(adapter.getState());
      terminal.append(terminal.activeSessionId, `포트 ${port} 개발 서버를 중지했습니다.\n`);
    }
  }

  async function startPreview(adapter: RuntimeAdapter): Promise<void> {
    const sessionId = terminal.activeSessionId;
    previewCancelRequestedRef.current = false;
    previousServerLogsRef.current = adapter.getState().serverLogs;
    setIsRunningPreview(true);
    setPreviewConsole([]);
    setBottomPanel("terminal");
    setIsTerminalOpen(true);
    terminal.append(sessionId, "❯ npm run dev\n의존성 설치 중\n");
    try {
      const next = await adapter.workflow.start();
      if (!next.previewUrl) throw new Error("Preview URL unavailable");
      terminal.append(sessionId, `설치됨\n개발 서버 준비 완료 · ${next.previewUrl}\n`);
      await swapPreviewBridge(adapter, next.previewUrl);
    } catch (error) {
      if (!unmountedRef.current && adapterRef.current === adapter) {
        const cause = error instanceof Error ? error.message.trim() : "";
        if (previewCancelRequestedRef.current || cause === "Preview controller operation cancelled") {
          previewCancelRequestedRef.current = false;
          terminal.append(sessionId, "미리보기 시작을 취소했습니다.\n");
          setError(undefined);
        } else {
          terminal.append(sessionId, cause ? `설치 실패: ${cause}\n` : "개발 서버를 시작하지 못했습니다.\n");
          setError(cause || "의존성 설치와 미리보기 실행을 완료하지 못했습니다.");
        }
      }
    } finally {
      if (!unmountedRef.current) setIsRunningPreview(false);
    }
  }

  function cancelRunningPreview(): void {
    previewCancelRequestedRef.current = true;
    try {
      adapterRef.current?.workflow.cancel();
    } catch {
      previewCancelRequestedRef.current = false;
      if (!unmountedRef.current) setError("미리보기 시작을 취소하지 못했습니다.");
    }
  }

  function recordPreviewConsole(entry: { level: StudioConsoleEntry["level"]; message: string; stack: string }, source: StudioConsoleEntry["source"] = "page"): void {
    if (unmountedRef.current) return;
    const message = entry.message.trim();
    if (!message) return;
    const id = previewConsoleIdRef.current + 1;
    previewConsoleIdRef.current = id;
    setPreviewConsole((current) => appendStudioConsole(current, { id, level: entry.level, message, source, stack: entry.stack }));
    if (source === "page") {
      setIsTerminalOpen(true);
      setBottomPanel("console");
    }
  }

  async function createPreviewBridge(internalPreviewUrl: string): Promise<SubdomainPreviewBridge> {
    if (previewConfiguration.status === "disabled") throw new Error("Preview unavailable");
    let created: SubdomainPreviewBridge | undefined;
    created = await (previewBridgeFactory ?? createSubdomainPreviewBridge)({
      configuration: previewConfiguration,
      internalProjectIdentity: `${workspaceScope}:${project.id}`,
      internalPreviewUrl,
      ownerId: project.ownerId,
      ownerType: project.ownerType,
      projectId: project.id,
      onConsole: recordPreviewConsole,
      onDiagnostic() {
        if (!unmountedRef.current) setError("격리된 미리보기 연결을 안전하게 중지했습니다.");
      },
      onReloadResult(ok) {
        if (!unmountedRef.current) setPreviewRefreshFailed(!ok);
      },
      onRecoveryRequired() {
        if (created) recoverPreview(created, internalPreviewUrl);
      }
    });
    return created;
  }

  function openPreviewWindow(): void {
    const internalPreviewUrl = adapterRef.current?.getState().previewUrl;
    if (!internalPreviewUrl || previewConfiguration.status === "disabled") return;
    setError(undefined);
    const previewWindowId = globalThis.crypto.randomUUID();
    const popup = globalThis.open(
      createPreviewWindowUrl(previewConfiguration.applicationOrigin, previewWindowId),
      "_blank"
    );
    if (!popup) {
      setError("새 탭을 열지 못했습니다. 브라우저의 팝업 차단 설정을 확인하세요.");
      return;
    }

    let activeBridge: SubdomainPreviewBridge | undefined;
    let bridgeOperation = 0;
    let connectionTimeout: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let closedPoll: ReturnType<typeof setInterval> | undefined;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      bridgeOperation += 1;
      if (connectionTimeout) clearTimeout(connectionTimeout);
      if (closedPoll) clearInterval(closedPoll);
      globalThis.removeEventListener("message", receive);
      previewWindowDisposersRef.current.delete(dispose);
      if (activeBridge) previewWindowBridgesRef.current.delete(activeBridge);
      void activeBridge?.dispose();
    };
    const reconnect = async () => {
      const operation = bridgeOperation + 1;
      bridgeOperation = operation;
      if (connectionTimeout) clearTimeout(connectionTimeout);
      let createdBridge: SubdomainPreviewBridge | undefined;
      try {
        createdBridge = await (previewBridgeFactory ?? createSubdomainPreviewBridge)({
          configuration: previewConfiguration,
          internalProjectIdentity: `${workspaceScope}:${project.id}`,
          internalPreviewUrl,
          ownerId: project.ownerId,
          ownerType: project.ownerType,
          projectId: project.id,
          onConnected() {
            if (createdBridge === activeBridge && connectionTimeout) {
              clearTimeout(connectionTimeout);
              connectionTimeout = undefined;
            }
          },
          onConsole: recordPreviewConsole,
          onDiagnostic: dispose,
          onRecoveryRequired() {
            if (createdBridge === activeBridge) void reconnect();
          }
        });
        if (disposed || popup.closed || operation !== bridgeOperation) {
          await createdBridge.dispose();
          return;
        }
        const previousBridge = activeBridge;
        activeBridge = createdBridge;
        previewWindowBridgesRef.current.add(createdBridge);
        createdBridge.attach(popup, previewConfiguration.applicationOrigin);
        popup.postMessage({
          type: "nuriteo-preview-window:initialize",
          previewWindowId,
          projectName: project.name,
          url: createdBridge.url,
          version: 1
        }, previewConfiguration.applicationOrigin);
        connectionTimeout = setTimeout(() => {
          if (createdBridge === activeBridge) void reconnect();
        }, PREVIEW_WINDOW_CONNECT_TIMEOUT_MS);
        if (previousBridge) {
          previewWindowBridgesRef.current.delete(previousBridge);
          void previousBridge.dispose();
        }
      } catch {
        dispose();
        popup.close();
        if (!unmountedRef.current) setError("새 탭 미리보기를 연결하지 못했습니다.");
      }
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== popup || event.origin !== previewConfiguration.applicationOrigin || typeof event.data !== "object" || event.data === null) return;
      const type = (event.data as Record<string, unknown>).type;
      const receivedPreviewWindowId = (event.data as Record<string, unknown>).previewWindowId;
      const version = (event.data as Record<string, unknown>).version;
      if (receivedPreviewWindowId !== previewWindowId || version !== 1) return;
      if (type === "nuriteo-preview-window:ready") {
        void reconnect();
      }
    };
    previewWindowDisposersRef.current.add(dispose);
    globalThis.addEventListener("message", receive);
    closedPoll = setInterval(() => {
      if (popup.closed) dispose();
    }, PREVIEW_WINDOW_CLOSED_POLL_MS);
  }

  async function swapPreviewBridge(
    adapter: RuntimeAdapter,
    internalPreviewUrl: string,
    expectedBridge?: SubdomainPreviewBridge
  ): Promise<boolean> {
    if (expectedBridge && previewBridgeRef.current !== expectedBridge) return false;

    const operation = previewBridgeOperationRef.current + 1;
    previewBridgeOperationRef.current = operation;
    const previousBridge = previewBridgeRef.current;
    previewBridgeRef.current = undefined;
    if (!unmountedRef.current) setIsolatedPreviewUrl(undefined);
    await previousBridge?.dispose();

    if (
      unmountedRef.current
      || adapterRef.current !== adapter
      || previewBridgeOperationRef.current !== operation
    ) return false;

    const createdBridge = await createPreviewBridge(internalPreviewUrl);
    if (
      unmountedRef.current
      || adapterRef.current !== adapter
      || previewBridgeOperationRef.current !== operation
    ) {
      await createdBridge.dispose();
      return false;
    }

    previewBridgeRef.current = createdBridge;
    createdBridge.attach(previewFrameRef.current?.contentWindow ?? null);
    setIsolatedPreviewUrl(createdBridge.url);
    setPreviewRefreshFailed(false);
    return true;
  }

  function recoverPreview(staleBridge: SubdomainPreviewBridge, internalPreviewUrl: string): void {
    if (previewRecoveryRef.current || previewBridgeRef.current !== staleBridge || unmountedRef.current) return;
    const adapter = adapterRef.current;
    if (!adapter) return;
    const recovery = (async () => {
      try {
        await swapPreviewBridge(adapter, internalPreviewUrl, staleBridge);
      } catch {
        if (!unmountedRef.current && adapterRef.current === adapter) {
          setError("격리된 미리보기 연결을 복구하지 못했습니다. 미리보기를 다시 실행하세요.");
        }
      }
    })().finally(() => { previewRecoveryRef.current = null; });
    previewRecoveryRef.current = recovery;
  }
  useEffect(() => {
    const fresh = freshServerLogLines(previousServerLogsRef.current, runtime.serverLogs);
    previousServerLogsRef.current = runtime.serverLogs;
    for (const line of fresh) recordPreviewConsole({ level: "info", message: line, stack: "" }, "server");
  }, [runtime.serverLogs]);
  session.hotUpdatePreviews = hotUpdatePreviews;
  session.runPreview = runPreview;
  session.refreshPreview = refreshPreview;
  session.postPreviewNavigation = postPreviewNavigation;
  session.submitPreviewAddress = submitPreviewAddress;
  session.movePreview = movePreview;
  session.stopPreviewPort = stopPreviewPort;
  session.startPreview = startPreview;
  session.cancelRunningPreview = cancelRunningPreview;
  session.recordPreviewConsole = recordPreviewConsole;
  session.createPreviewBridge = createPreviewBridge;
  session.openPreviewWindow = openPreviewWindow;
  session.swapPreviewBridge = swapPreviewBridge;
  session.recoverPreview = recoverPreview;
  session.attachPreviewFrame = attachPreviewFrame;
}

export function StudioPreviewPanel({ session }: { readonly session: StudioShellSession }) {
  const {
    attachPreviewFrame,
    beginHorizontalResize,
    cancelRunningPreview,
    css,
    hasIsolatedPreview,
    isRunningPreview,
    isolatedPreviewUrl,
    movePreview,
    openPreviewWindow,
    previewAddress,
    previewAddressEditingRef,
    previewConfiguration,
    previewHistory,
    previewRefreshFailed,
    previewWidth,
    project,
    refreshPreview,
    runPreview,
    runtime,
    setIsPreviewOpen,
    setPreviewAddress,
    submitPreviewAddress,
    utilityLayout
  } = session;
  function previewPendingNotice() {
    if (runtime.previewUrl) return (<div className={css.utilityEmpty()} role="status"><strong>격리된 연결을 준비하고 있습니다.</strong><p>격리된 미리보기 연결이 아직 준비되지 않았습니다. 동일 출처 미리보기는 비활성화되어 있습니다.</p></div>);
    return (<div className={css.utilityEmpty()}><span aria-hidden="true">▷</span><strong>실행 결과를 바로 확인하세요</strong><p>의존성을 설치하고 개발 서버를 시작합니다.</p></div>);
  }
  function previewUnavailableNotice() {
    if (previewConfiguration.status === "disabled") return (<div className={css.utilityEmpty()} role="status"><strong>미리보기를 사용할 수 없습니다.</strong><p>{previewConfiguration.message} 동일 출처 미리보기는 보안을 위해 비활성화되어 있습니다.</p></div>);
    return (previewPendingNotice());
  }
  const restartDevServerLabel = isRunningPreview ? ("취소") : ("개발 서버 다시 실행");
  function previewStoppedNotice() {
    if (previewRefreshFailed) return (<div className="absolute inset-0 grid place-content-center justify-items-center bg-raised/95 p-8 text-center" role="alert"><strong className="text-sm text-foreground">개발 서버가 중지되었습니다.</strong><p className="mb-4 mt-2 max-w-sm text-xs text-muted-foreground">새로고침할 수 없습니다. 개발 서버를 다시 실행하면 현재 로컬 초안으로 미리보기를 복구합니다.</p><Button type="button" size="sm" variant="primary" onClick={() => { if (isRunningPreview) cancelRunningPreview(); else void runPreview(); }}>{restartDevServerLabel}</Button></div>);
    return (null);
  }
  function isolatedPreviewFrame() {
    if (hasIsolatedPreview) return (<div className="relative min-h-0 overflow-hidden"><iframe className="block size-full" ref={attachPreviewFrame} title={`${project.name} 미리보기`} src={isolatedPreviewUrl} sandbox="allow-scripts allow-same-origin" allow="cross-origin-isolated" referrerPolicy="no-referrer" />{previewStoppedNotice()}</div>);
    return (previewUnavailableNotice());
  }
  const previewRunButtonLabel = isRunningPreview ? ("취소") : ("실행");
  const previewRunLabel = isRunningPreview ? ("미리보기 취소") : ("미리보기 실행");
  function isolatedPreviewActions() {
    if (hasIsolatedPreview) return (<><span className={css.live()}><i aria-hidden="true" /> 실행 중</span><Button className="grid size-7 place-items-center rounded-sm border-0 bg-transparent text-xs text-muted-foreground hover:bg-hover hover:text-foreground" type="button" size="icon" variant="ghost" onClick={openPreviewWindow} aria-label="미리보기를 새 탭에서 열기" title="새 탭에서 열기">↗</Button></>);
    return (<Button aria-label={previewRunLabel} type="button" size="sm" variant="primary" onClick={() => { if (isRunningPreview) cancelRunningPreview(); else void runPreview(); }}>{previewRunButtonLabel}</Button>);
  }
  const previewAddressPlaceholder = hasIsolatedPreview ? ("/") : ("미리보기를 실행하세요");
  return (
          <section className={css.utility({ className: utilityLayout })} aria-label="미리보기 패널">
            <div className="absolute inset-y-0 left-[-0.25rem] z-20 w-2 cursor-col-resize touch-none max-[72rem]:hidden" role="separator" aria-label="미리보기 너비 조절" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={720} aria-valuenow={previewWidth} onPointerDown={(event) => beginHorizontalResize("preview", event)} />
            <section className={css.preview()} aria-label="미리보기" data-preview-url={isolatedPreviewUrl}>
              <div className={css.previewToolbar()}>
                <div className={css.previewControls()}>
                  <Button type="button" size="icon" variant="ghost" aria-label="미리보기 뒤로" disabled={!hasIsolatedPreview || previewHistory.index === 0} onClick={() => movePreview(-1)}>←</Button>
                  <Button type="button" size="icon" variant="ghost" aria-label="미리보기 앞으로" disabled={!hasIsolatedPreview || previewHistory.index >= previewHistory.entries.length - 1} onClick={() => movePreview(1)}>→</Button>
                  <Button type="button" size="icon" variant="ghost" aria-label="미리보기 새로고침" disabled={isRunningPreview || !hasIsolatedPreview} onClick={refreshPreview}>↻</Button>
                </div>
                <form className={css.previewAddress()} title={isolatedPreviewUrl ?? runtime.previewUrl ?? undefined} onSubmit={submitPreviewAddress}>
                  <span aria-hidden="true">▣</span>
                  <Input className="h-auto min-h-0 w-auto rounded-none border-0 bg-transparent p-0 font-mono text-[0.625rem] text-foreground shadow-none outline-none disabled:bg-transparent disabled:text-muted-foreground" aria-label="미리보기 주소" value={previewAddress} disabled={!hasIsolatedPreview} spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder={previewAddressPlaceholder} onFocus={() => { previewAddressEditingRef.current = true; }} onBlur={() => { previewAddressEditingRef.current = false; setPreviewAddress(previewHistory.entries[previewHistory.index] ?? "/"); }} onChange={(event) => setPreviewAddress(event.currentTarget.value)} />
                </form>
                <div className={css.previewActions()}>{isolatedPreviewActions()}<Button aria-label="미리보기 닫기" type="button" size="sm" variant="ghost" onClick={() => setIsPreviewOpen(false)}>×</Button></div>
              </div>
              {isolatedPreviewFrame()}
            </section>
          </section>
  );
}

export function StudioPreviewConsole({ session }: { readonly session: StudioShellSession }) {
  const {
    bottomPanel,
    previewConsole
  } = session;
  function consoleEntries() {
    if (previewConsole.length > 0) return (<ul className="m-0 grid list-none gap-3 p-0">{previewConsole.map((entry) => {
          function consoleStackTrace() {
            if (entry.stack && entry.stack !== entry.message) return (<pre className="m-0 whitespace-pre-wrap text-white/45">{entry.stack}</pre>);
            return (null);
          }
          return (<li className="grid gap-1 border-b border-white/10 pb-2" key={entry.id}><p className={`m-0 whitespace-pre-wrap ${previewConsoleTone(entry.level)}`}><span className="mr-2 text-white/40">{studioConsoleSourceLabel(entry.source)}</span><span className="mr-2 uppercase text-white/40">{entry.level}</span><span>{entry.message}</span></p>{consoleStackTrace()}</li>);
        })}</ul>);
    return (<p className="m-0 text-white/55">미리보기 콘솔 출력이 없습니다.</p>);
  }
  function previewConsolePanel() {
    if (bottomPanel === "console") return (<div className="min-h-0 overflow-auto p-3 font-mono text-xs text-white/75" role="log" aria-label="미리보기 콘솔">{consoleEntries()}</div>);
    return (null);
  }
  return previewConsolePanel();
}

export function StudioPreviewConsoleActions({ session }: { readonly session: StudioShellSession }) {
  const {
    bottomPanel,
    previousServerLogsRef,
    runtime,
    setPreviewConsole
  } = session;
  function clearConsoleButton() {
    if (bottomPanel === "console") return (<Button type="button" size="icon" variant="ghost" aria-label="콘솔 내용 지우기" title="콘솔 내용 지우기" onClick={() => { previousServerLogsRef.current = runtime.serverLogs; setPreviewConsole([]); }}>⌫</Button>);
    return (null);
  }
  return clearConsoleButton();
}

export function StudioPreviewPorts({ session }: { readonly session: StudioShellSession }) {
  const {
    bottomPanel,
    css,
    openPreviewWindow,
    runtime,
    stopPreviewPort
  } = session;
  function portListBody() {
    if (runtime.ports.length > 0) return (<ul className={css.runtimeList()} aria-label="열린 포트">{runtime.ports.map((port) => {
          const portStatusLabel = port.status === "running" ? ("실행 중") : ("중지됨");
          return (<li key={port.port}><div className="grid min-w-0 gap-0.5"><strong>{port.label} · localhost:{port.port}</strong><span>{portStatusLabel} · <Button className="border-0 bg-transparent p-0 font-inherit text-[var(--n-color-studio-success)] hover:underline" type="button" size="sm" variant="ghost" onClick={openPreviewWindow}>브라우저에서 열기</Button></span></div><Button type="button" size="sm" variant="ghost" aria-label={`포트 ${port.port} 중지`} onClick={() => void stopPreviewPort(port.port)}>중지</Button></li>);
        })}</ul>);
    return (<p className="m-0 p-3 text-xs text-white/55">열린 개발 서버 포트가 없습니다.</p>);
  }
  const portList = bottomPanel === "ports" ? (portListBody()) : (null);
  return portList;
}

