import { Bell, CheckCircle2, CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import clsx from "clsx";
import type { PreviewControllerModel } from "../hooks/usePreviewController";

const LEVEL_ICONS = {
  info: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  error: CircleAlert
};

export function NotificationCenter({ model }: { model: PreviewControllerModel }) {
  return (
    <div className="relative">
      <button
        type="button"
        className="icon-btn relative"
        aria-label={`Notifications (${model.notifications.length})`}
        aria-expanded={model.notificationOpen}
        onClick={() => model.setNotificationOpen(!model.notificationOpen)}
      >
        <Bell className="size-4" />
        {model.notifications.length > 0 ? (
          <span className="absolute -top-1 -right-1 min-w-4 rounded-full bg-nuriteo-bad px-1 text-center text-[9px] leading-4 text-white">
            {Math.min(99, model.notifications.length)}
          </span>
        ) : null}
      </button>
      {model.notificationOpen ? (
        <section
          className="absolute top-9 right-0 z-[100] w-80 overflow-hidden rounded-lg border border-nuriteo-line bg-nuriteo-panel shadow-[var(--shadow)]"
          aria-label="Notification center"
        >
          <header className="flex items-center justify-between border-b border-nuriteo-line px-3 py-2">
            <h2 className="text-xs font-semibold text-nuriteo-ink">Notifications</h2>
            <button type="button" className="text-[10px] text-nuriteo-muted hover:text-nuriteo-ink" onClick={model.clearNotifications}>
              Clear all
            </button>
          </header>
          {model.notifications.length === 0 ? (
            <p className="px-3 py-5 text-center text-xs text-nuriteo-muted">No notifications.</p>
          ) : (
            <ol className="max-h-80 overflow-auto p-2">
              {model.notifications.map((notification) => {
                const Icon = LEVEL_ICONS[notification.level];
                return (
                  <li key={notification.id} className="flex gap-2 rounded-md px-2 py-2 hover:bg-nuriteo-panel-2">
                    <Icon
                      className={clsx(
                        "mt-0.5 size-4 shrink-0",
                        notification.level === "error" && "text-nuriteo-bad",
                        notification.level === "warning" && "text-nuriteo-warn",
                        notification.level === "success" && "text-nuriteo-ok",
                        notification.level === "info" && "text-nuriteo-focus"
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-nuriteo-ink">{notification.title}</p>
                      <p className="mt-0.5 break-words text-[11px] text-nuriteo-muted">{notification.message}</p>
                    </div>
                    <button
                      type="button"
                      className="self-start rounded p-0.5 text-nuriteo-muted hover:text-nuriteo-ink"
                      aria-label={`Dismiss ${notification.title}`}
                      onClick={() => model.dismissNotification(notification.id)}
                    >
                      <X className="size-3" />
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      ) : null}
    </div>
  );
}
