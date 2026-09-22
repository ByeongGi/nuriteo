import type { PreviewWorkflowEvent } from "@cargo-container/preview-service";

export type NotificationLevel = "info" | "success" | "warning" | "error";

export interface IdeNotification {
  id: string;
  title: string;
  message: string;
  level: NotificationLevel;
  createdAt: number;
}

export type NotificationDraft = Omit<IdeNotification, "id" | "createdAt">;

export function notificationForWorkflowEvent(event: PreviewWorkflowEvent): NotificationDraft | null {
  if (event.type === "preview-ready") {
    return { title: "Preview ready", message: event.snapshot.previewUrl || "Dev server is running.", level: "success" };
  }
  if (event.type === "build") {
    return { title: "Build completed", message: "Project build completed successfully.", level: "success" };
  }
  if (event.type === "import-failed") {
    return { title: "Import needs attention", message: "Project validation failed. Open Problems for details.", level: "warning" };
  }
  if (event.type === "error") {
    return {
      title: "Workflow failed",
      message: event.snapshot.lastError?.message || "The runtime reported an error.",
      level: "error"
    };
  }
  return null;
}
