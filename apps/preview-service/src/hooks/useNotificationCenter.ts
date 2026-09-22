import { useCallback, useRef, useState } from "react";
import type { IdeNotification, NotificationDraft } from "../lib/notifications";

const MAX_NOTIFICATIONS = 50;

export function useNotificationCenter() {
  const [notifications, setNotifications] = useState<IdeNotification[]>([]);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const sequence = useRef(0);

  const pushNotification = useCallback((draft: NotificationDraft) => {
    sequence.current += 1;
    const notification: IdeNotification = {
      ...draft,
      id: `notification-${sequence.current}`,
      createdAt: Date.now()
    };
    setNotifications((current) => [notification, ...current].slice(0, MAX_NOTIFICATIONS));
    return notification.id;
  }, []);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((current) => current.filter((notification) => notification.id !== id));
  }, []);

  const clearNotifications = useCallback(() => setNotifications([]), []);

  return {
    notifications,
    notificationOpen,
    setNotificationOpen,
    pushNotification,
    dismissNotification,
    clearNotifications
  };
}
