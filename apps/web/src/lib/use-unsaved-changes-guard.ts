"use client";

import { useEffect } from "react";

const DEFAULT_MESSAGE = "저장하지 않은 변경 사항이 있습니다. 이 화면을 나갈까요?";

export function useUnsavedChangesGuard(
  shouldBlock: boolean,
  message = DEFAULT_MESSAGE
): void {
  useEffect(() => {
    if (!shouldBlock) return;

    function preventWindowClose(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }

    function confirmInternalNavigation(event: MouseEvent) {
      if (
        event.defaultPrevented
        || event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
        || event.altKey
      ) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;

      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin || destination.href === window.location.href) return;
      if (window.confirm(message)) return;

      event.preventDefault();
      event.stopImmediatePropagation();
    }

    window.addEventListener("beforeunload", preventWindowClose);
    document.addEventListener("click", confirmInternalNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", preventWindowClose);
      document.removeEventListener("click", confirmInternalNavigation, true);
    };
  }, [message, shouldBlock]);
}
