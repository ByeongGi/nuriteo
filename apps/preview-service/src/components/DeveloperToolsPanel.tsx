import { useCallback, useState } from "react";

import type { PreviewControllerModel } from "../hooks/usePreviewController";
import { DebuggerPanel } from "./DebuggerPanel";
import { ExtensionHostPanel } from "./ExtensionHostPanel";

export function DeveloperToolsPanel({ model }: { model: PreviewControllerModel }) {
  const [error, setError] = useState("");
  const reportError = useCallback((message: string) => setError(message), []);

  return (
    <aside className="flex h-full min-h-0 flex-col bg-cargo-elevated/80" aria-label="Run and Extensions">
      <ExtensionHostPanel model={model} onError={reportError} />
      <DebuggerPanel onError={reportError} />
      {error ? <p id="developer-tools-error" className="border-t border-cargo-line px-3 py-2 text-xs text-red-400">{error}</p> : null}
    </aside>
  );
}
