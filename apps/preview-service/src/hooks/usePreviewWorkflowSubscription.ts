import { useEffect, useRef } from "react";
import {
  PHASES,
  type PreviewWorkflowController,
  type PreviewWorkflowSnapshot
} from "@nuriteo/preview-service";
import { CloudProjectsClient } from "../lib/cloudProjects";
import {
  notificationForWorkflowEvent,
  type NotificationDraft
} from "../lib/notifications";

interface PreviewWorkflowSubscriptionOptions {
  controller: PreviewWorkflowController;
  onDiagnostics(): void;
  onHmrUpdate(): void;
  onPreviewReady(snapshot: PreviewWorkflowSnapshot): void;
  onSnapshot(snapshot: PreviewWorkflowSnapshot): void;
  pushNotification(notification: NotificationDraft): string;
}

export function usePreviewWorkflowSubscription(
  options: PreviewWorkflowSubscriptionOptions
): void {
  const callbacksRef = useRef(options);
  callbacksRef.current = options;
  const runtimeStartedAtRef = useRef<number | null>(null);

  useEffect(() => {
    const unsubscribe = options.controller.on((event) => {
      const callbacks = callbacksRef.current;
      const notification = notificationForWorkflowEvent(event);
      if (notification) callbacks.pushNotification(notification);

      const cloudToken = localStorage.getItem("nuriteo.cloud-session") || "";
      if (cloudToken && event.type === "phase" && event.detail.phase === PHASES.installed) {
        void new CloudProjectsClient({ token: () => cloudToken }).ingestUsage({
          id: `install:${event.snapshot.projectId || "project"}:${crypto.randomUUID()}`,
          kind: "install",
          quantity: 1,
          occurredAt: new Date().toISOString()
        }).catch(() => undefined);
      }

      if (event.type === "preview-ready") {
        runtimeStartedAtRef.current = Date.now();
        callbacks.onPreviewReady(event.snapshot);
      } else if (event.type === "hmr-update") {
        callbacks.onHmrUpdate();
      }

      if (
        cloudToken
        && event.type === "phase"
        && event.detail.stopped === true
        && runtimeStartedAtRef.current !== null
      ) {
        const minutes = Math.max(0, (Date.now() - runtimeStartedAtRef.current) / 60_000);
        runtimeStartedAtRef.current = null;
        void new CloudProjectsClient({ token: () => cloudToken }).ingestUsage({
          id: `runtime:${event.snapshot.projectId || "project"}:${crypto.randomUUID()}`,
          kind: "runtime_minutes",
          quantity: minutes,
          occurredAt: new Date().toISOString()
        }).catch(() => undefined);
      }

      if (event.snapshot.diagnostics.length > 0 || event.snapshot.phase === PHASES.failed) {
        callbacks.onDiagnostics();
      }
      callbacks.onSnapshot(event.snapshot);
    });
    return () => {
      unsubscribe();
    };
  }, [options.controller]);
}
