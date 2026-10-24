import type { PreviewChangeKind, SubdomainPreviewBridge } from "#src/runtime/subdomain-preview-bridge.ts";

type PreviewHotUpdateTarget = Pick<SubdomainPreviewBridge, "hotUpdate">;

export function hotUpdatePreviewBridges(
  primary: PreviewHotUpdateTarget | undefined,
  additional: Iterable<PreviewHotUpdateTarget>,
  path: string,
  changeKind: PreviewChangeKind = "content"
): void {
  primary?.hotUpdate(path, changeKind);
  for (const bridge of additional) bridge.hotUpdate(path, changeKind);
}
